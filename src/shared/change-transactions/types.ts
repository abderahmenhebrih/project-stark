/**
 * Shared change-transaction domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A change transaction is a REVIEWABLE proposal: creating one never
 * touches the project file. Only an explicit Accept flows through the
 * Stage 8 writer, and only an explicit Rollback restores the checkpoint.
 * The schema can hold many files per transaction, but the Stage 9
 * editor creates exactly one file change per transaction.
 */

/** Lifecycle of a change transaction. Terminal states never transition. */
export type ChangeTransactionStatus = 'pending' | 'applied' | 'rejected' | 'rolled_back'

/**
 * One file inside a transaction. Revisions are SHA-256 hex digests over
 * exact bytes; contents are exact UTF-8 text. No absolute or temp paths.
 */
export interface ChangeTransactionFile {
  readonly relativePath: string
  readonly beforeRevision: string
  readonly proposedRevision: string
  readonly appliedRevision: string | null
  readonly beforeContent: string
  readonly proposedContent: string
}

/** Public transaction: persistence row mapped to display-safe data. */
export interface ChangeTransaction {
  readonly id: number
  readonly workspaceId: number
  readonly status: ChangeTransactionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly appliedAt: number | null
  readonly rejectedAt: number | null
  readonly rolledBackAt: number | null
  readonly files: readonly ChangeTransactionFile[]
}

/**
 * Proposal request. Deliberately shaped like the Stage 8 write request,
 * except it persists ONLY transaction data — never the project file.
 */
export interface CreateFileChangeRequest {
  readonly workspaceId: number
  readonly relativePath: string
  readonly expectedRevision: string
  readonly proposedContent: string
}

/** Reference to one persisted transaction. */
export interface ChangeTransactionRequest {
  readonly transactionId: number
}

/** Workspace-scoped recent-history request. */
export interface ListChangeTransactionsRequest {
  readonly workspaceId: number
}

/** Changes slice of the preload bridge (`window.stark.workspace.changes`). */
export interface WorkspaceChangesApi {
  create: (request: CreateFileChangeRequest) => Promise<ChangeTransaction>
  get: (request: ChangeTransactionRequest) => Promise<ChangeTransaction>
  listRecent: (request: ListChangeTransactionsRequest) => Promise<readonly ChangeTransaction[]>
  accept: (request: ChangeTransactionRequest) => Promise<ChangeTransaction>
  reject: (request: ChangeTransactionRequest) => Promise<ChangeTransaction>
  rollback: (request: ChangeTransactionRequest) => Promise<ChangeTransaction>
}
