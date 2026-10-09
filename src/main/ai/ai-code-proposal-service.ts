import { TextEncoder } from 'node:util'
import type { ChangeTransaction } from '../../shared/change-transactions/types'
import type { AiProposeFileChangeRequest, AiFileChangeProposalResult } from '../../shared/ai/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import {
  ChangeTransactionConflictError,
  ChangeTransactionNoChangesError
} from '../change-transactions/errors'
import {
  SessionNotFoundError,
  SessionWorkspaceMismatchError,
  SessionWorkspaceUnavailableError
} from '../sessions/errors'
import {
  GenerationInFlightError,
  ProviderModelMissingError,
  ProviderStructuredOutputUnsupportedError,
  UnknownProviderError
} from './errors'
import {
  InvalidProposalOutputError,
  InvalidProposalRequestError,
  ProposalContextMissingError,
  ProposalNoChangesError,
  ProposalNothingToProposeError,
  ProposalStaleBeforeProviderError,
  ProposalStaleDuringProviderError,
  ProposalTooLargeError
} from './ai-proposal-errors'
import {
  MAX_AI_CONTEXT_BYTES,
  MAX_AI_CONTEXT_MESSAGES,
  MAX_AI_PROPOSED_FILE_BYTES,
  MAX_AI_PROPOSAL_SUMMARY_CODEPOINTS,
  MAX_ASSISTANT_OUTPUT_TOKENS,
  STAGE_16_FIXED_PROPOSAL_INSTRUCTIONS
} from './limits'
import type { AiProviderService } from './ai-provider-service'
import { AiOperationGuard } from './ai-operation-guard'
import { PendingApprovalBlockedError } from '../worker-tools/worker-tool-errors'
import type { ProviderRegistry } from './provider-adapter'
import type { AiUsageDeps } from '../usage/ai-usage-tracker'
import { formatProviderContext } from '../session-context/session-context-service'

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

function countCodePoints(value: string): number {
  return [...value].length
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

/** Main-process-owned structured output schema name. Never renderer supplied. */
export const PROPOSAL_SCHEMA_NAME = 'stark_file_change_proposal'

/**
 * Main-process-owned proposal schema. The model may return ONLY
 * summary + proposedContent — no path, revision, commands, or tools.
 */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'proposedContent'],
  properties: {
    summary: { type: 'string' },
    proposedContent: { type: 'string' }
  }
} as const

export interface AiCodeProposalServiceOptions {
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
  /** Shared per-session AI lock. Defaults to a private guard. */
  readonly operationGuard?: AiOperationGuard
  /** Stage 23 approval gate (optional): unresolved approvals block new proposals. */
  readonly pendingApprovals?: { hasPending(sessionId: number): boolean }
  /**
   * Stage 28 local usage awareness (optional). When present, the
   * single structured provider call is recorded in the local usage
   * ledger (tracked, never threshold-routed). Absent means legacy
   * untracked behavior.
   */
  readonly usage?: AiUsageDeps
}

/**
 * AI code-proposal service (Stage 16): turns the trailing user
 * message's exactly-one whole-file attachment into a single pending
 * Stage 9 Change Transaction via one structured provider call.
 *
 * The AI never writes: proposals persist via `ChangeTransactionService`
 * only, and only a human Accept reaches the Stage 8 writer. No
 * terminal, Git, tools, file creation/deletion/rename, or hidden
 * reads. One attempt, no retries, no loops.
 */
export class AiCodeProposalService {
  private readonly now: () => number
  private readonly guard: AiOperationGuard
  private readonly pendingApprovals: { hasPending(sessionId: number): boolean } | undefined
  private readonly usage: AiUsageDeps | undefined

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly providerConfigs: AiProviderRepository,
    private readonly providerService: AiProviderService,
    private readonly registry: ProviderRegistry,
    private readonly files: WorkspaceFilesService,
    private readonly transactions: ChangeTransactionService,
    options?: AiCodeProposalServiceOptions
  ) {
    this.now = options?.now ?? Date.now
    this.guard = options?.operationGuard ?? new AiOperationGuard()
    this.pendingApprovals = options?.pendingApprovals
    this.usage = options?.usage
  }

  /**
   * Stage 28 central tracking boundary: the single structured
   * proposal call passes through here (tracked, never
   * threshold-routed). Telemetry never retries the call.
   */
  private trackCall<T>(
    meta: { workspaceId: number; sessionId: number },
    providerId: string,
    model: string,
    invoke: () => Promise<T>
  ): Promise<T> {
    if (this.usage === undefined) {
      return invoke()
    }
    return this.usage.tracker.track(
      { operation: 'single_proposal', role: 'proposal', providerId, model, workspaceId: meta.workspaceId, sessionId: meta.sessionId, runId: null },
      invoke
    )
  }

  async proposeFileChange(payload: unknown): Promise<AiFileChangeProposalResult> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidProposalRequestError('proposal request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidProposalRequestError('session reference is invalid')
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
    this.guard.acquire(sessionId)
    try {
      return await this.proposeInner(workspaceId, sessionId)
    } finally {
      this.guard.release(sessionId)
    }
  }

  private async proposeInner(workspaceId: number, sessionId: number): Promise<AiFileChangeProposalResult> {
    const latest = this.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new ProposalNothingToProposeError()
    }
    const persisted = this.sessions.listContextForMessage(latest.id)
    const wholeFiles = persisted.filter((entry) => entry.kind === 'whole-file')
    const excerpts = persisted.filter((entry) => entry.kind === 'file-excerpt')
    const searchMatches = persisted.filter((entry) => entry.kind === 'search-match')
    if (wholeFiles.length !== 1 || excerpts.length !== 0 || searchMatches.length !== 0) {
      throw new ProposalContextMissingError()
    }
    const target = wholeFiles[0]
    if (target === undefined || typeof target.relativePath !== 'string' || target.relativePath === '') {
      throw new ProposalContextMissingError()
    }
    const relativePath = target.relativePath
    const reviewedContent = target.content

    // Pre-provider stale check: current disk must exactly equal the
    // persisted reviewed content. No provider tokens on stale source.
    let currentContent: string
    let capturedRevision: string
    try {
      const file = await this.files.readTextFile({ workspaceId, relativePath })
      currentContent = file.content
      capturedRevision = file.revision
    } catch {
      throw new ProposalStaleBeforeProviderError()
    }
    if (currentContent !== reviewedContent) {
      throw new ProposalStaleBeforeProviderError()
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
    if (typeof adapter.generateStructured !== 'function') {
      throw new ProviderStructuredOutputUnsupportedError()
    }
    // Captured after the guard so the tracking closure keeps the
    // narrowed function type (narrowing is lost inside closures).
    // Bound to preserve adapter `this`.
    const generateStructured = adapter.generateStructured.bind(adapter)

    const context = this.loadContext(sessionId)
    const trailing = context[context.length - 1]
    if (trailing === undefined) {
      throw new ProposalNothingToProposeError()
    }
    const providerMessages =
      persisted.length === 0
        ? context
        : [...context.slice(0, -1), { role: 'user' as const, content: formatProviderContext(persisted) }, trailing]

    const apiKey = await this.providerService.decryptCredentialForUse(providerId)
    let outputText: string
    try {
      const result = await this.trackCall(
        { workspaceId, sessionId },
        adapter.id,
        model,
        () => generateStructured({
          apiKey,
          model,
          instructions: STAGE_16_FIXED_PROPOSAL_INSTRUCTIONS,
          messages: providerMessages,
          maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
          schemaName: PROPOSAL_SCHEMA_NAME,
          schema: PROPOSAL_JSON_SCHEMA
        })
      )
      outputText = result.outputText
    } finally {
      void apiKey
    }

    const { summary, proposedContent } = this.parseAndValidateOutput(outputText)
    if (proposedContent === currentContent) {
      throw new ProposalNoChangesError()
    }

    // Post-provider stale protection: create through Stage 9 with the
    // pre-provider revision. A mid-generation disk change fails here.
    let transaction: ChangeTransaction
    try {
      transaction = await this.transactions.createFileChange({
        workspaceId,
        relativePath,
        expectedRevision: capturedRevision,
        proposedContent
      })
    } catch (error) {
      if (error instanceof ChangeTransactionConflictError) {
        throw new ProposalStaleDuringProviderError({ cause: error })
      }
      if (error instanceof ChangeTransactionNoChangesError) {
        throw new ProposalNoChangesError()
      }
      throw error
    }
    if (transaction.status !== 'pending') {
      throw new InvalidProposalOutputError()
    }
    void this.now
    return { transaction, summary }
  }

  private parseAndValidateOutput(outputText: unknown): { summary: string; proposedContent: string } {
    if (typeof outputText !== 'string' || outputText === '') {
      throw new InvalidProposalOutputError()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(outputText) as unknown
    } catch {
      throw new InvalidProposalOutputError()
    }
    if (!hasStrictShape(parsed, ['summary', 'proposedContent'])) {
      throw new InvalidProposalOutputError()
    }
    const summary = (parsed as Record<string, unknown>)['summary']
    const proposedContent = (parsed as Record<string, unknown>)['proposedContent']
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw new InvalidProposalOutputError()
    }
    if (summary.includes('\0')) {
      throw new InvalidProposalOutputError()
    }
    if (countCodePoints(summary) > MAX_AI_PROPOSAL_SUMMARY_CODEPOINTS) {
      throw new InvalidProposalOutputError()
    }
    if (typeof proposedContent !== 'string' || proposedContent === '') {
      throw new InvalidProposalOutputError()
    }
    if (proposedContent.includes('\0')) {
      throw new InvalidProposalOutputError()
    }
    if (hasUnpairedSurrogate(proposedContent)) {
      throw new InvalidProposalOutputError()
    }
    if (encoder.encode(proposedContent).byteLength > MAX_AI_PROPOSED_FILE_BYTES) {
      throw new ProposalTooLargeError()
    }
    return { summary: summary.trim(), proposedContent }
  }

  /**
   * Newest session messages within both context budgets, returned
   * chronologically. Mirrors the completion service: at most
   * MAX_AI_CONTEXT_MESSAGES newest rows, oldest dropped while over
   * budget, always retaining the trailing user message.
   */
  loadContext(sessionId: number): { readonly role: 'user' | 'assistant'; readonly content: string }[] {
    const probe = this.sessions.listMessagesNewestFirst(sessionId, MAX_AI_CONTEXT_MESSAGES, null)
    const kept = [...probe.slice(0, MAX_AI_CONTEXT_MESSAGES)]
    let total = 0
    for (const entry of kept) {
      total += encoder.encode(entry.content).byteLength
    }
    while (kept.length > 1 && total > MAX_AI_CONTEXT_BYTES) {
      const dropped = kept.pop()
      if (dropped !== undefined) {
        total -= encoder.encode(dropped.content).byteLength
      }
    }
    return kept.reverse().map((entry) => ({ role: entry.role, content: entry.content }))
  }
}

/** Type-only request shape guard for documentation; runtime uses strict keys. */
export function isAiProposeFileChangeRequest(value: unknown): value is AiProposeFileChangeRequest {
  return hasStrictShape(value, ['workspaceId', 'sessionId'])
}
