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
import { InvalidSessionMessageError, SessionMessageTooLargeError, SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'
import { validateUserMessageContent } from '../sessions/message-validation'

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
}

/**
 * AI completion service (Stage 14): turns the trailing user message
 * of a workspace-owned session into one persisted assistant message
 * from the single configured provider. No files, no terminal, no Git,
 * no tools, no project context — only bounded local session text plus
 * the fixed main-owned instruction. Exactly one generation runs per
 * session; the user message is never deleted or resent on failure.
 */
export class AiCompletionService {
  private readonly now: () => number
  private readonly inFlight = new Set<number>()

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly providerConfigs: AiProviderRepository,
    private readonly providerService: AiProviderService,
    private readonly registry: ProviderRegistry,
    options?: AiCompletionServiceOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  async generateResponse(payload: unknown): Promise<AiGenerateResult> {
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
    if (this.inFlight.has(sessionId)) {
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
    this.inFlight.add(sessionId)
    try {
      const context = this.loadContext(sessionId)
      const apiKey = await this.providerService.decryptCredentialForUse(providerId)
      let text: string
      try {
        const result = await adapter.generateText({
          apiKey,
          model,
          instructions: STAGE_14_FIXED_INSTRUCTIONS,
          messages: context,
          maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS
        })
        text = result.text
      } finally {
        void apiKey
      }
      const content = this.validateAssistantText(text)
      const now = this.now()
      // Main-process-only assistant append: atomic message insert plus
      // session timestamp advance, never a retitle. Unreachable from
      // the renderer — no IPC path takes a role.
      const { messageId } = this.sessions.appendMessage({
        sessionId,
        role: 'assistant',
        content,
        now,
        retitle: null
      })
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
          createdAt: message.createdAt
        } satisfies CodingMessage
      }
    } finally {
      this.inFlight.delete(sessionId)
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
