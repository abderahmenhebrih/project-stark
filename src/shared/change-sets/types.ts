/**
 * Shared change-set domain contract (Stage 17).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A Change Set persistently groups the pending Stage 9 transactions
 * produced by one multi-file AI proposal. It groups review — it is
 * NOT an atomic filesystem commit: each child remains an ordinary
 * Stage 9 transaction with individual Accept/Reject/Rollback, and
 * every disk write remains an individual human-approved Stage 8
 * operation. There is deliberately no Accept All.
 */

import type { ChangeTransaction } from '../change-transactions/types'

/** The only Change Set kind created in Stage 17. */
export type ChangeSetKind = 'ai_multi_file_proposal'

/**
 * Derived group state, computed from child transaction statuses —
 * never persisted, so it cannot drift from the children.
 * - pending: every child is pending
 * - partially_resolved: a mixture including at least one pending
 * - resolved: no child remains pending
 */
export type ChangeSetStatus = 'pending' | 'partially_resolved' | 'resolved'

/** One file inside a Change Set: ordinal position plus its transaction. */
export interface ChangeSetItem {
  readonly ordinal: number
  readonly transaction: ChangeTransaction
  readonly fileSummary: string
}

/** Public Change Set: header plus items in ordinal order. */
export interface ChangeSet {
  readonly id: number
  readonly workspaceId: number
  readonly kind: ChangeSetKind
  readonly summary: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly items: readonly ChangeSetItem[]
}

/** Reference to one persisted Change Set. */
export interface ChangeSetRequest {
  readonly changeSetId: number
}

/** Workspace-scoped recent-history request. */
export interface ListChangeSetsRequest {
  readonly workspaceId: number
}

/** Change-sets slice of the preload bridge (`window.stark.changeSets`). */
export interface ChangeSetsApi {
  get: (request: ChangeSetRequest) => Promise<ChangeSet>
  listRecent: (request: ListChangeSetsRequest) => Promise<readonly ChangeSet[]>
}
