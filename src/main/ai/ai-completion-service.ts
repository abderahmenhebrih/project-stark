import { TextEncoder } from 'node:util'
import type { AiGenerateResult } from '../../shared/ai/types'
import type { CodingMessage } from '../../shared/sessions/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { AiProviderService } from './ai-provider-service'
import {
  GenerationInFlightError,
  InvalidProviderRequestError,
  NothingToAnswerError,
  ProviderEmptyResponseError,
  ProviderModelMissingError,
  UnknownProviderError
} from './errors'
import { MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MESSAGES, MAX_ASSISTANT_OUTPUT_TOKENS, STAGE_14_FIXED_INSTRUCTIONS } from './limits'
import type { ProviderRegistry } from './provider-adapter'
import { formatProviderContext } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import type { LooplinkRepository } from '../looplink/looplink-repository'
import type { LooplinkService } from '../looplink/looplink-service'
import type { ChatAttachmentService } from '../chat-attachments/service'
import { buildChatAttachmentSection } from './ai-attachment-resolver'
import type { ProviderAttachmentContent } from './provider-adapter'
import { InvalidSessionMessageError, SessionMessageTooLargeError, SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'
import { validateUserMessageContent } from '../sessions/message-validation'
import { PendingApprovalBlockedError } from '../worker-tools/worker-tool-errors'
import type { AiUsageDeps } from '../usage/ai-usage-tracker'

const encoder = new TextEncoder()

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function contextBytes(messages: readonly { readonly content: string }[]): number {
  let total = 0
  for (const entry of messages) {
    total += encoder.encode(entry.content).byteLength
  }
  return total
}

export interface AiCompletionServiceOptions {
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
  /** Shared per-session AI lock (Stage 16). Defaults to a private guard. */
  readonly operationGuard?: AiOperationGuard
  /**
   * Stage 20 continuity (optional). When present, a pending Looplink
   * for the session travels as historical data and is consumed
   * atomically with the assistant message. Absent means legacy
   * behavior — existing harnesses keep working.
   */
  readonly looplink?: { readonly service: LooplinkService; readonly store: LooplinkRepository }
  /**
   * Stage 23 approval gate (optional). When present, a session with an
   * unresolved Worker approval rejects new Ask work with a safe
   * pending-approval error instead of holding the AI guard. Existing
   * human workflows never consult capabilities — this blocks only new
   * AI operations while approval waits.
   */
  readonly pendingApprovals?: { hasPending(sessionId: number): boolean }
  /**
   * Stage 28 local usage awareness (optional). When present, every
   * outbound provider call is recorded in the local usage ledger
   * through the central tracker. Absent means legacy untracked
   * behavior — existing harnesses keep working.
   */
  readonly usage?: AiUsageDeps
  /**
   * Step 2 chat-attachment understanding (optional). When present,
   * the trailing message's committed attachments are resolved
   * main-side and offered to the provider per model capability.
   * Absent means attachments travel as explicitly-labeled metadata
   * only — legacy harnesses keep working, nothing is sent silently.
   */
  readonly attachments?: ChatAttachmentService
}

/**
 * AI completion service (Stage 14, extended in Stage 15): turns the
 * trailing user message of a workspace-owned session into one
 * persisted assistant message from the single configured provider.
 * No files, no terminal, no Git, no tools — only bounded local
 * session text, the trailing message's explicit user-attached
 * context, and the fixed main-owned instruction. Exactly one
 * generation runs per session; the user message is never deleted or
 * resent on failure.
 */
export class AiCompletionService {
  private readonly now: () => number
  private readonly guard: AiOperationGuard
  private readonly looplink: { readonly service: LooplinkService; readonly store: LooplinkRepository } | undefined
  private readonly pendingApprovals: { hasPending(sessionId: number): boolean } | undefined
  private readonly usage: AiUsageDeps | undefined
  private readonly attachmentService: ChatAttachmentService | undefined

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly providerConfigs: AiProviderRepository,
    private readonly providerService: AiProviderService,
    private readonly registry: ProviderRegistry,
    options?: AiCompletionServiceOptions
  ) {
    this.now = options?.now ?? Date.now
    this.guard = options?.operationGuard ?? new AiOperationGuard()
    this.looplink = options?.looplink
    this.pendingApprovals = options?.pendingApprovals
    this.usage = options?.usage
    this.attachmentService = options?.attachments
  }

  /**
   * Stage 28 central tracking boundary: every outbound provider
   * invocation in this service passes through here. Records one
   * local usage event (or invokes directly when usage awareness is
   * absent in older harnesses). Telemetry never retries the call.
   */
  private trackCall<T>(
    meta: {
      operation: 'ask' | 'recovery_ask'
      workspaceId: number
      sessionId: number
    },
    providerId: string,
    model: string,
    invoke: () => Promise<T>
  ): Promise<T> {
    if (this.usage === undefined) {
      return invoke()
    }
    return this.usage.tracker.track(
      {
        operation: meta.operation,
        role: meta.operation === 'ask' ? 'ask' : 'recovery',
        providerId,
        model,
        workspaceId: meta.workspaceId,
        sessionId: meta.sessionId,
        runId: null
      },
      invoke
    )
  }

  /**
   * Step 2 chat-attachment section for one trailing message (shared
   * builder — same rows the renderer displays, same block the model
   * receives).
   */
  private loadChatAttachmentSection(
    messageId: number,
    providerId: string,
    model: string
  ): { readonly block: string | null; readonly payloads: readonly ProviderAttachmentContent[] } {
    return buildChatAttachmentSection({
      sessions: this.sessions,
      attachments: this.attachmentService,
      messageId,
      providerId,
      model
    })
  }

  /**
   * Inserts the attachment review block ahead of the trailing user
   * message (after any explicit project-context block). The block is
   * part of the reviewed provider input — Stage 15 invariant.
   */
  private withChatAttachmentBlock(
    base: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[],
    block: string | null
  ): readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] {
    if (block === null || base.length === 0) {
      return base
    }
    const trailing = base[base.length - 1]
    if (trailing === undefined) {
      return base
    }
    return [...base.slice(0, -1), { role: 'user' as const, content: block }, trailing]
  }

  async generateResponse(payload: unknown): Promise<AiGenerateResult> {    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidProviderRequestError('generation request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidProviderRequestError('session reference is invalid')
    }
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    if (this.pendingApprovals?.hasPending(sessionId) === true) {
      throw new PendingApprovalBlockedError()
    }
    if (this.guard.isActive(sessionId)) {
      throw new GenerationInFlightError()
    }
    const latest = this.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new NothingToAnswerError()
    }
    const providerId = this.providerService.requireProvider('openai')
    const config = this.providerConfigs.findConfig(providerId)
    const model = config?.selectedModel ?? null
    if (model === null || model === '') {
      throw new ProviderModelMissingError()
    }
    const adapter = this.registry.get(providerId)
    if (adapter === undefined) {
      throw new UnknownProviderError()
    }
      this.guard.acquire(sessionId)
    try {
      return await this.generateWithAdapter(workspaceId, sessionId, latest.id, providerId, adapter, model, null, 'ask')
    } finally {
      this.guard.release(sessionId)
    }
  }

  /**
   * Main-internal recovery Ask (Stage 21): runs one Ask in the target
   * session using the explicit Recovery Ask assignment. Never reads
   * or mutates the legacy selected model. The renderer cannot call
   * this — only the recovery coordinator does, after atomic target
   * creation. Recovery routing is explicit per-request.
   */
  async generateResponseWithRecovery(
    payload: unknown,
    recovery: { providerId: string; model: string },
    options?: { excludeDuplicateText?: string | null }
  ): Promise<AiGenerateResult> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidProviderRequestError('generation request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidProviderRequestError('session reference is invalid')
    }
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    if (this.guard.isActive(sessionId)) {
      throw new GenerationInFlightError()
    }
    const latest = this.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new NothingToAnswerError()
    }
    const resolved = await this.providerService.resolveExplicitAssignment(recovery.providerId, recovery.model)
    this.guard.acquire(sessionId)
    try {
      return await this.generateWithAdapter(
        workspaceId,
        sessionId,
        latest.id,
        recovery.providerId as never,
        resolved.adapter,
        resolved.model,
        options?.excludeDuplicateText ?? null,
        'recovery_ask',
        resolved.apiKey
      )
    } finally {
      this.guard.release(sessionId)
    }
  }

  /**
   * Main-internal recovery text (Stage 21): calls the explicit
   * Recovery Ask assignment once and returns validated text plus the
   * pending Looplink id WITHOUT persisting. The coordinator persists
   * atomically via the recovery repository (assistant + consume +
   * event success in one transaction). Guard is held for the provider
   * call only, then released before persistence to avoid nested locks.
   */
  async generateRecoveryTextOnly(
    payload: unknown,
    recovery: { providerId: string; model: string },
    options?: { excludeDuplicateText?: string | null }
  ): Promise<{ text: string; looplinkId: number | null }> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidProviderRequestError('generation request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidProviderRequestError('session reference is invalid')
    }
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    if (this.guard.isActive(sessionId)) {
      throw new GenerationInFlightError()
    }
    const latest = this.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new NothingToAnswerError()
    }
    const resolved = await this.providerService.resolveExplicitAssignment(recovery.providerId, recovery.model)
    this.guard.acquire(sessionId)
    try {
      const context = this.loadContext(sessionId)
      const attachments = this.sessions.listContextForMessage(latest.id)
      const trailing = context[context.length - 1]
      if (trailing === undefined) {
        throw new NothingToAnswerError()
      }
      const withAttachments =
        attachments.length === 0
          ? context
          : [...context.slice(0, -1), { role: 'user' as const, content: formatProviderContext(attachments) }, trailing]
      const chatSection = this.loadChatAttachmentSection(latest.id, resolved.adapter.id, resolved.model)
      const withChatAttachments = this.withChatAttachmentBlock(withAttachments, chatSection.block)
      const exclude = options?.excludeDuplicateText ?? null
      const loop =
        this.looplink === undefined
          ? null
          : exclude === null
            ? (this.looplink.service.getPendingBlock(workspaceId, sessionId) ?? null)
            : (this.looplink.service.getPendingBlockExcluding(workspaceId, sessionId, exclude) ?? null)
      const providerMessages =
        loop === null
          ? withChatAttachments
          : [
              ...withChatAttachments.slice(0, -1),
              { role: 'user' as const, content: loop.block },
              withChatAttachments[withChatAttachments.length - 1] as { readonly role: 'user' | 'assistant'; readonly content: string }
            ]
      let raw: string
      // Bound capture for the tracking closure (preserves adapter `this`).
      const generateRecoveryText = resolved.adapter.generateText.bind(resolved.adapter)
      try {
        const result = await this.trackCall(
          { operation: 'recovery_ask', workspaceId, sessionId },
          resolved.adapter.id,
          resolved.model,
          () => generateRecoveryText({
            apiKey: resolved.apiKey,
            model: resolved.model,
            instructions: STAGE_14_FIXED_INSTRUCTIONS,
            messages: providerMessages,
            maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
            ...(chatSection.payloads.length > 0 ? { attachments: chatSection.payloads } : {})
          })
        )
        raw = result.text
      } finally {
        void resolved.apiKey
      }
      const content = this.validateAssistantText(raw)
      return { text: content, looplinkId: loop?.looplinkId ?? null }
    } finally {
      this.guard.release(sessionId)
    }
  }

  private async generateWithAdapter(
    workspaceId: number,
    sessionId: number,
    latestMessageId: number,
    providerId: Parameters<AiProviderService['decryptCredentialForUse']>[0],
    adapter: NonNullable<ReturnType<ProviderRegistry['get']>>,
    model: string,
    excludeDuplicateText: string | null,
    operation: 'ask' | 'recovery_ask',
    preResolvedApiKey?: string
  ): Promise<AiGenerateResult> {
      const context = this.loadContext(sessionId)
      // Only the trailing message's explicit attachments travel with
      // the request — older history arrives as plain message text.
      const attachments = this.sessions.listContextForMessage(latestMessageId)
      const trailing = context[context.length - 1]
      if (trailing === undefined) {
        throw new NothingToAnswerError()
      }
      const withAttachments =
        attachments.length === 0
          ? context
          : [...context.slice(0, -1), { role: 'user' as const, content: formatProviderContext(attachments) }, trailing]
      const chatSection = this.loadChatAttachmentSection(latestMessageId, adapter.id, model)
      const withChatAttachments = this.withChatAttachmentBlock(withAttachments, chatSection.block)
      // Pending Looplink continuity travels as historical user-role
      // data ahead of the active request — never as an instruction.
      // Recovery dedup excludes the replayed active request from the
      // historical block so the model sees it exactly once.
      const loop =
        this.looplink === undefined
          ? null
          : excludeDuplicateText === null
            ? (this.looplink.service.getPendingBlock(workspaceId, sessionId) ?? null)
            : (this.looplink.service.getPendingBlockExcluding(workspaceId, sessionId, excludeDuplicateText) ?? null)
      const providerMessages =
        loop === null
          ? withChatAttachments
          : [
              ...withChatAttachments.slice(0, -1),
              { role: 'user' as const, content: loop.block },
              withChatAttachments[withChatAttachments.length - 1] as { readonly role: 'user' | 'assistant'; readonly content: string }
            ]
      const apiKey = preResolvedApiKey ?? (await this.providerService.decryptCredentialForUse(providerId))
      // Bound capture for the tracking closure (preserves adapter `this`).
      const generateText = adapter.generateText.bind(adapter)
      let text: string
      try {
        const result = await this.trackCall(
          { operation, workspaceId, sessionId },
          adapter.id,
          model,
          () => generateText({
            apiKey,
            model,
            instructions: STAGE_14_FIXED_INSTRUCTIONS,
            messages: providerMessages,
            maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
            ...(chatSection.payloads.length > 0 ? { attachments: chatSection.payloads } : {})
          })
        )
        text = result.text
      } finally {
        void apiKey
      }
      const content = this.validateAssistantText(text)
      const now = this.now()
      // Main-process-only assistant append: atomic message insert plus
      // session timestamp advance, never a retitle. Unreachable from
      // the renderer — no IPC path takes a role. When continuity was
      // used, the pending Looplink is consumed in the same atomic
      // transaction — never message-without-consume or vice versa.
      const messageId =
        loop === null || this.looplink === undefined
          ? this.sessions.appendMessage({
              sessionId,
              role: 'assistant',
              content,
              now,
              retitle: null
            }).messageId
          : this.looplink.store.appendAssistantMessageAndConsume({
              sessionId,
              content,
              now,
              looplinkId: loop.looplinkId,
              retitle: null
            }).messageId
      const message = this.sessions.findMessageById(messageId)
      const updated = this.sessions.findSessionById(sessionId)
      if (message === undefined || updated === undefined) {
        throw new SessionNotFoundError()
      }
      return {
        session: {
          id: updated.id,
          workspaceId: updated.workspaceId,
          title: updated.title,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt
        },
        message: {
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          context: []
        } satisfies CodingMessage
      }
  }

  /**
   * Newest session messages within both context budgets, returned
   * chronologically. Oldest-first dropping keeps the trailing user
   * message (index 0 of the newest-first probe is always retained).
   */
  loadContext(sessionId: number): { readonly role: 'user' | 'assistant'; readonly content: string }[] {
    // The repository returns a limit+1 hasMore probe; generation takes
    // at most MAX_AI_CONTEXT_MESSAGES newest rows, then drops oldest
    // while over the byte budget (always retaining the trailing user
    // message at probe index 0).
    const probe = this.sessions.listMessagesNewestFirst(sessionId, MAX_AI_CONTEXT_MESSAGES, null)
    const kept = [...probe.slice(0, MAX_AI_CONTEXT_MESSAGES)]
    while (kept.length > 1 && contextBytes(kept) > MAX_AI_CONTEXT_BYTES) {
      kept.pop()
    }
    return kept
      .reverse()
      .map((entry) => ({ role: entry.role, content: entry.content }))
  }

  private validateAssistantText(text: unknown): string {
    try {
      return validateUserMessageContent(text)
    } catch (error) {
      if (error instanceof InvalidSessionMessageError || error instanceof SessionMessageTooLargeError) {
        throw new ProviderEmptyResponseError({ cause: error })
      }
      throw error
    }
  }
}
