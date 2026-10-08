import type { ChangeSetService } from '../change-sets/change-set-service'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeTransactionConflictError, ChangeTransactionNoChangesError } from '../change-transactions/errors'
import type { WorkerToolRepository } from './worker-tool-repository'
import { buildReadRefMap } from './worker-read-ref'
import type { ValidatedProposalChange } from './worker-proposal-validation'
import {
  WORKER_PROPOSAL_STALE_MESSAGE,
  WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE
} from './worker-proposal-validation'

/** One resolved proposal target: path/authority from same-run read, text from model. */
export interface ResolvedProposalTarget {
  readonly targetRef: string
  readonly relativePath: string
  readonly expectedRevision: string
  readonly reviewedContent: string
  readonly summary: string
  readonly proposedContent: string
}

export type ResolveProposalOutcome =
  | { readonly ok: true; readonly resolved: readonly ResolvedProposalTarget[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolves opaque same-run readRefs to exact file authority.
 * Reads ONLY persisted successful workspace_read events for the SAME
 * run; verifies same workspace/session via the stored event scope.
 * Search/Git/denied/failed/foreign-run refs never resolve. Model
 * paths are never consulted — inert text only.
 */
export function resolveProposalTargets(input: {
  tools: WorkerToolRepository
  runId: number
  workspaceId: number
  sessionId: number
  changes: readonly ValidatedProposalChange[]
}): ResolveProposalOutcome {
  const events = input.tools.listEvents(input.runId)
  const map = buildReadRefMap(
    events.map((event) => ({
      toolName: event.toolName,
      status: event.status,
      payload: event.payload,
      workspaceId: event.workspaceId,
      sessionId: event.sessionId
    }))
  )
  if (map === undefined) {
    return { ok: false, reason: WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE }
  }
  // Scope check: every candidate event must belong to the same
  // workspace/session/run. Events are already filtered by runId; verify
  // the stored scope when available (extended rows) and always verify
  // the run header implicitly via the runId filter.
  for (const event of events) {
    if (event.workspaceId !== input.workspaceId || event.sessionId !== input.sessionId) {
      // An event from another workspace/session in the same run id would
      // be a storage inconsistency — fail closed.
      return { ok: false, reason: WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE }
    }
  }
  const resolved: ResolvedProposalTarget[] = []
  for (const change of input.changes) {
    const decoded = map.get(change.targetRef)
    if (decoded === undefined) {
      return { ok: false, reason: WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE }
    }
    resolved.push({
      targetRef: change.targetRef,
      relativePath: decoded.relativePath,
      expectedRevision: decoded.revision,
      reviewedContent: decoded.content,
      summary: change.summary,
      proposedContent: change.proposedContent
    })
  }
  return { ok: true, resolved }
}

/** Drops no-op items (proposed equals exact reviewed bytes). */
export function dropNoOpTargets(resolved: readonly ResolvedProposalTarget[]): readonly ResolvedProposalTarget[] {
  return resolved.filter((entry) => entry.proposedContent !== entry.reviewedContent)
}

/**
 * Builds the exact human-readable approval summary for a resolved
 * proposal. Single: "Create reviewable change proposal for <path>".
 * Multi: "Create reviewable change proposal for N files". Details list
 * each resolved relative path plus per-file summary, then the explicit
 * non-apply copy. No absolute paths, no ref-only display.
 */
export function buildProposalApprovalSummary(resolved: readonly ResolvedProposalTarget[]): string {
  const header =
    resolved.length === 1 && resolved[0] !== undefined
      ? `Create reviewable change proposal for ${resolved[0].relativePath}`
      : `Create reviewable change proposal for ${String(resolved.length)} files`
  const lines = resolved.map((entry) => `${entry.relativePath} — ${entry.summary}`)
  return (
    `${header}\n\n` +
    `Worker wants to create a reviewable proposal.\n` +
    `Files:\n${lines.map((line) => `- ${line}`).join('\n')}\n\n` +
    `Approval creates a reviewable proposal only. It does not modify files. ` +
    `Files will not change until you review and Accept them.`
  )
}

export type CreateProposalOutcome =
  | { readonly kind: 'single'; readonly transactionId: number; readonly files: readonly { readonly relativePath: string; readonly summary: string }[] }
  | { readonly kind: 'change_set'; readonly changeSetId: number; readonly files: readonly { readonly relativePath: string; readonly summary: string }[] }
  | { readonly kind: 'no_changes' }
  | { readonly kind: 'stale' }

/**
 * Creates the pending proposal through the EXISTING Stage 9 / Stage 17
 * services only. No direct writes, no Accept, no file creation. Stale
 * disk revisions fail closed with kind stale; no-op-only input yields
 * no_changes with zero persistence. Zero provider calls.
 */
export async function createWorkerProposal(input: {
  transactions: ChangeTransactionService
  changeSets: ChangeSetService
  workspaceId: number
  resolved: readonly ResolvedProposalTarget[]
}): Promise<CreateProposalOutcome> {
  const effective = dropNoOpTargets(input.resolved)
  if (effective.length === 0) {
    return { kind: 'no_changes' }
  }
  if (effective.length === 1) {
    const single = effective[0]
    if (single === undefined) {
      return { kind: 'no_changes' }
    }
    try {
      const created = await input.transactions.createFileChange({
        workspaceId: input.workspaceId,
        relativePath: single.relativePath,
        expectedRevision: single.expectedRevision,
        proposedContent: single.proposedContent
      })
      const file = created.files[0]
      return {
        kind: 'single',
        transactionId: created.id,
        files: [{ relativePath: file?.relativePath ?? single.relativePath, summary: single.summary }]
      }
    } catch (error) {
      if (error instanceof ChangeTransactionConflictError) {
        return { kind: 'stale' }
      }
      if (error instanceof ChangeTransactionNoChangesError) {
        return { kind: 'no_changes' }
      }
      throw error
    }
  }
  const files = effective.map((entry) => ({
    relativePath: entry.relativePath,
    expectedRevision: entry.expectedRevision,
    proposedContent: entry.proposedContent,
    fileSummary: entry.summary
  }))
  const summary = `Worker proposal for ${String(effective.length)} files`
  try {
    const created = await input.changeSets.createAiChangeSet(input.workspaceId, summary, files)
    return {
      kind: 'change_set',
      changeSetId: created.id,
      files: effective.map((entry) => ({ relativePath: entry.relativePath, summary: entry.summary }))
    }
  } catch (error) {
    if (error instanceof ChangeTransactionConflictError) {
      return { kind: 'stale' }
    }
    if (error instanceof ChangeTransactionNoChangesError) {
      return { kind: 'no_changes' }
    }
    // Change-set stale surfaces through the same conflict class (shared
    // Stage 9 primitive); any invalid-request mapping for missing files
    // is treated as stale-safe failure only when it is a conflict.
    const message = error instanceof Error ? error.message : ''
    if (message.includes('changed on disk') || message.includes('changed while')) {
      return { kind: 'stale' }
    }
    throw error
  }
}

/** Maps a stale outcome to the canonical bounded Worker copy. */
export function staleReason(): string {
  return WORKER_PROPOSAL_STALE_MESSAGE
}
