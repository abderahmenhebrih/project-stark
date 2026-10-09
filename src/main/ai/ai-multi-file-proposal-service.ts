import { TextEncoder } from 'node:util'
import type { ChangeSet } from '../../shared/change-sets/types'
import type { AiChangeSetProposalResult } from '../../shared/ai/types'
import type { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { ChangeSetService } from '../change-sets/change-set-service'
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
  ChangeSetContextMissingError,
  ChangeSetNoChangesError,
  ChangeSetNothingToProposeError,
  ChangeSetStaleBeforeProviderError,
  ChangeSetStaleDuringProviderError,
  ChangeSetTooLargeError,
  InvalidChangeSetOutputError,
  InvalidChangeSetRequestError
} from './ai-change-set-errors'
import {
  MAX_AI_CHANGE_SET_FILES,
  MAX_AI_CHANGE_SET_FILE_SUMMARY_CODEPOINTS,
  MAX_AI_CHANGE_SET_SUMMARY_CODEPOINTS,
  MAX_AI_CHANGE_SET_TOTAL_PROPOSED_BYTES,
  MAX_AI_CONTEXT_BYTES,
  MAX_AI_CONTEXT_MESSAGES,
  MAX_AI_PROPOSED_FILE_BYTES,
  MAX_ASSISTANT_OUTPUT_TOKENS,
  MIN_AI_CHANGE_SET_FILES,
  STAGE_17_FIXED_MULTI_FILE_INSTRUCTIONS
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
export const CHANGE_SET_SCHEMA_NAME = 'stark_grouped_file_change_proposal'

/**
 * Builds the main-process-owned Change Set schema for exactly
 * `targetCount` eligible targets. The model may return ONLY summary +
 * changes with targetId/summary/proposedContent — no paths,
 * revisions, commands, tools, or transaction references.
 */
export function buildChangeSetJsonSchema(targetCount: number): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'changes'],
    properties: {
      summary: { type: 'string' },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: targetCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['targetId', 'summary', 'proposedContent'],
          properties: {
            targetId: { type: 'string' },
            summary: { type: 'string' },
            proposedContent: { type: 'string' }
          }
        }
      }
    }
  }
}

interface ValidatedChange {
  readonly targetId: string
  readonly summary: string
  readonly proposedContent: string
}

export interface AiMultiFileProposalServiceOptions {
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
 * AI multi-file proposal service (Stage 17): turns 2–5 trailing
 * whole-file attachments into one persistent Change Set holding one
 * pending Stage 9 transaction per changed file, via one structured
 * provider call. Temporary opaque target IDs (T1..Tn) map main-side
 * to persisted context rows — the model never controls paths. No
 * disk writes, no Accept All, no retries, no loops.
 */
export class AiMultiFileProposalService {
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
    private readonly changeSets: ChangeSetService,
    options?: AiMultiFileProposalServiceOptions
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
      { operation: 'multi_proposal', role: 'proposal', providerId, model, workspaceId: meta.workspaceId, sessionId: meta.sessionId, runId: null },
      invoke
    )
  }

  async proposeChangeSet(payload: unknown): Promise<AiChangeSetProposalResult> {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidChangeSetRequestError('change-set proposal request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidChangeSetRequestError('session reference is invalid')
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

  private async proposeInner(workspaceId: number, sessionId: number): Promise<AiChangeSetProposalResult> {
    const latest = this.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new ChangeSetNothingToProposeError()
    }
    const persisted = this.sessions.listContextForMessage(latest.id)
    const wholeFiles = persisted.filter((entry) => entry.kind === 'whole-file')
    const excerpts = persisted.filter((entry) => entry.kind === 'file-excerpt')
    const searchMatches = persisted.filter((entry) => entry.kind === 'search-match')
    if (
      wholeFiles.length < MIN_AI_CHANGE_SET_FILES ||
      wholeFiles.length > MAX_AI_CHANGE_SET_FILES ||
      excerpts.length !== 0 ||
      searchMatches.length !== 0
    ) {
      throw new ChangeSetContextMissingError()
    }
    const notes = persisted.filter((entry) => entry.kind === 'manual-note')

    // Temporary opaque target IDs, main-owned, never persisted.
    const targets = wholeFiles.map((entry, index) => {
      if (typeof entry.relativePath !== 'string' || entry.relativePath === '') {
        throw new ChangeSetContextMissingError()
      }
      return {
        targetId: `T${String(index + 1)}`,
        relativePath: entry.relativePath as string,
        reviewedContent: entry.content
      }
    })
    const byTargetId = new Map(targets.map((target) => [target.targetId, target]))

    // Pre-provider stale validation for ALL targets; capture revisions.
    const currentByTarget = new Map<string, { content: string; revision: string }>()
    for (const target of targets) {
      let current: string
      let revision: string
      try {
        const file = await this.files.readTextFile({ workspaceId, relativePath: target.relativePath })
        current = file.content
        revision = file.revision
      } catch {
        throw new ChangeSetStaleBeforeProviderError()
      }
      if (current !== target.reviewedContent) {
        throw new ChangeSetStaleBeforeProviderError()
      }
      currentByTarget.set(target.targetId, { content: current, revision })
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
      throw new ChangeSetNothingToProposeError()
    }
    const targetBlocks = targets
      .map((target) => `[TARGET ${target.targetId}]\nPath: ${target.relativePath}\nContent:\n${target.reviewedContent}`)
      .join('\n\n')
    const notesBlock = notes.length === 0 ? '' : `\n\n${formatProviderContext(notes)}`
    const providerMessages = [
      ...context.slice(0, -1),
      { role: 'user' as const, content: `${targetBlocks}${notesBlock}` },
      trailing
    ]

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
          instructions: STAGE_17_FIXED_MULTI_FILE_INSTRUCTIONS,
          messages: providerMessages,
          maxOutputTokens: MAX_ASSISTANT_OUTPUT_TOKENS,
          schemaName: CHANGE_SET_SCHEMA_NAME,
          schema: buildChangeSetJsonSchema(targets.length)
        })
      )
      outputText = result.outputText
    } finally {
      void apiKey
    }

    const { summary, changes } = this.parseAndValidateOutput(outputText, byTargetId)

    // Drop per-target no-ops against pre-provider content.
    const effective = changes.filter((change) => {
      const current = currentByTarget.get(change.targetId)
      return current !== undefined && change.proposedContent !== current.content
    })
    if (effective.length === 0) {
      throw new ChangeSetNoChangesError()
    }

    // Post-provider stale validation: re-read every proposed target.
    const freshRevision = new Map<string, string>()
    for (const change of effective) {
      const target = byTargetId.get(change.targetId)
      if (target === undefined) {
        throw new InvalidChangeSetOutputError()
      }
      let revision: string
      try {
        const file = await this.files.readTextFile({ workspaceId, relativePath: target.relativePath })
        revision = file.revision
      } catch {
        throw new ChangeSetStaleDuringProviderError()
      }
      if (revision !== currentByTarget.get(change.targetId)?.revision) {
        throw new ChangeSetStaleDuringProviderError()
      }
      freshRevision.set(change.targetId, revision)
    }

    // Atomic grouped persistence through the Change Set service.
    let changeSet: ChangeSet
    try {
      changeSet = await this.changeSets.createAiChangeSet(
        workspaceId,
        summary,
        effective.map((change) => {
          const target = byTargetId.get(change.targetId)
          if (target === undefined) {
            throw new InvalidChangeSetOutputError()
          }
          return {
            relativePath: target.relativePath,
            expectedRevision: freshRevision.get(change.targetId) ?? '',
            proposedContent: change.proposedContent,
            fileSummary: change.summary
          }
        })
      )
    } catch (error) {
      if (error instanceof ChangeTransactionConflictError) {
        throw new ChangeSetStaleDuringProviderError({ cause: error })
      }
      if (error instanceof ChangeTransactionNoChangesError) {
        throw new ChangeSetNoChangesError()
      }
      throw error
    }
    void this.now
    return { changeSet }
  }

  private parseAndValidateOutput(
    outputText: unknown,
    byTargetId: ReadonlyMap<string, { relativePath: string; reviewedContent: string }>
  ): { summary: string; changes: ValidatedChange[] } {
    if (typeof outputText !== 'string' || outputText === '') {
      throw new InvalidChangeSetOutputError()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(outputText) as unknown
    } catch {
      throw new InvalidChangeSetOutputError()
    }
    if (!hasStrictShape(parsed, ['summary', 'changes'])) {
      throw new InvalidChangeSetOutputError()
    }
    const record = parsed as Record<string, unknown>
    const summary = record['summary']
    const changes = record['changes']
    if (typeof summary !== 'string' || summary.trim() === '' || summary.includes('\0')) {
      throw new InvalidChangeSetOutputError()
    }
    if (countCodePoints(summary) > MAX_AI_CHANGE_SET_SUMMARY_CODEPOINTS) {
      throw new InvalidChangeSetOutputError()
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > byTargetId.size) {
      throw new InvalidChangeSetOutputError()
    }
    const seen = new Set<string>()
    const validated: ValidatedChange[] = []
    let totalBytes = 0
    for (const change of changes) {
      if (!hasStrictShape(change, ['targetId', 'summary', 'proposedContent'])) {
        throw new InvalidChangeSetOutputError()
      }
      const entry = change as Record<string, unknown>
      const targetId = entry['targetId']
      const fileSummary = entry['summary']
      const proposedContent = entry['proposedContent']
      if (typeof targetId !== 'string' || !byTargetId.has(targetId) || seen.has(targetId)) {
        throw new InvalidChangeSetOutputError()
      }
      seen.add(targetId)
      if (typeof fileSummary !== 'string' || fileSummary.trim() === '' || fileSummary.includes('\0')) {
        throw new InvalidChangeSetOutputError()
      }
      if (countCodePoints(fileSummary) > MAX_AI_CHANGE_SET_FILE_SUMMARY_CODEPOINTS) {
        throw new InvalidChangeSetOutputError()
      }
      if (typeof proposedContent !== 'string' || proposedContent === '' || proposedContent.includes('\0')) {
        throw new InvalidChangeSetOutputError()
      }
      if (hasUnpairedSurrogate(proposedContent)) {
        throw new InvalidChangeSetOutputError()
      }
      const bytes = encoder.encode(proposedContent).byteLength
      if (bytes > MAX_AI_PROPOSED_FILE_BYTES) {
        throw new InvalidChangeSetOutputError()
      }
      totalBytes += bytes
      validated.push({ targetId, summary: fileSummary.trim(), proposedContent })
    }
    if (totalBytes > MAX_AI_CHANGE_SET_TOTAL_PROPOSED_BYTES) {
      throw new ChangeSetTooLargeError()
    }
    return { summary: (summary as string).trim(), changes: validated }
  }

  /**
   * Newest session messages within both context budgets, returned
   * chronologically — same budgets as single-file Ask/proposal paths.
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
