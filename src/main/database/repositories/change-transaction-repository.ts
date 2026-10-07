import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ChangeTransactionStatus } from '../../../shared/change-transactions/types'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError('stored change transaction row is invalid')
  }
  return numeric
}

/** Raw transaction row as stored (snake_case, nullable timestamps). */
export interface StoredChangeTransaction {
  readonly id: number
  readonly workspaceId: number
  readonly status: ChangeTransactionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly appliedAt: number | null
  readonly rejectedAt: number | null
  readonly rolledBackAt: number | null
}

/** Raw transaction-file row as stored (exact bytes as BLOBs). */
export interface StoredChangeTransactionFile {
  readonly id: number
  readonly transactionId: number
  readonly relativePath: string
  readonly beforeRevision: string
  readonly beforeBytes: Buffer
  readonly proposedRevision: string
  readonly proposedBytes: Buffer
  readonly appliedRevision: string | null
}

const VALID_STATUSES: readonly string[] = ['pending', 'applied', 'rejected', 'rolled_back']

function asMillis(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number') {
    throw new DatabaseError('stored change transaction row is invalid')
  }
  return value
}

function mapTransaction(row: unknown): StoredChangeTransaction {
  if (!isRecord(row)) {
    throw new DatabaseError('stored change transaction row is invalid')
  }
  const status = row['status']
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) {
    throw new DatabaseError('stored change transaction row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored change transaction row is invalid')
  }
  return {
    id,
    workspaceId,
    status: status as ChangeTransactionStatus,
    createdAt,
    updatedAt,
    appliedAt: asMillis(row['applied_at']),
    rejectedAt: asMillis(row['rejected_at']),
    rolledBackAt: asMillis(row['rolled_back_at'])
  }
}

/**
 * node:sqlite returns BLOB columns as Uint8Array views (not necessarily
 * Buffer instances), so every stored blob is normalized to a Buffer
 * copy here — the only place BLOB bytes enter the domain.
 */
function asStoredBytes(value: unknown): Buffer {
  if (value instanceof Buffer) {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }
  throw new DatabaseError('stored change transaction file row is invalid')
}

function mapFile(row: unknown): StoredChangeTransactionFile {
  if (!isRecord(row)) {
    throw new DatabaseError('stored change transaction file row is invalid')
  }
  const id = row['id']
  const transactionId = row['transaction_id']
  const relativePath = row['relative_path']
  const beforeRevision = row['before_revision']
  const proposedRevision = row['proposed_revision']
  const appliedRevision = row['applied_revision']
  if (
    typeof id !== 'number' ||
    typeof transactionId !== 'number' ||
    typeof relativePath !== 'string' ||
    typeof beforeRevision !== 'string' ||
    typeof proposedRevision !== 'string' ||
    (appliedRevision !== null && typeof appliedRevision !== 'string')
  ) {
    throw new DatabaseError('stored change transaction file row is invalid')
  }
  return {
    id,
    transactionId,
    relativePath,
    beforeRevision,
    beforeBytes: asStoredBytes(row['before_bytes']),
    proposedRevision,
    proposedBytes: asStoredBytes(row['proposed_bytes']),
    appliedRevision
  }
}

export interface NewChangeTransaction {
  readonly workspaceId: number
  readonly now: number
}

export interface NewChangeTransactionFile {
  readonly relativePath: string
  readonly beforeRevision: string
  readonly beforeBytes: Buffer
  readonly proposedRevision: string
  readonly proposedBytes: Buffer
}

/**
 * Typed main-process repository over change_transactions and
 * change_transaction_files. Persistence only: no filesystem access, no
 * hashing, no Stage 8 calls. Every statement is prepared once with
 * parameter binding; multi-row creation is wrapped in one SQLite
 * transaction, and status updates are conditional on the expected prior
 * status so concurrent transitions cannot interleave.
 */
export class ChangeTransactionRepository {
  private readonly db: DatabaseSync
  private readonly insertTransactionStmt: StatementSync
  private readonly insertFileStmt: StatementSync
  private readonly findTransactionStmt: StatementSync
  private readonly findFilesStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly markAppliedStmt: StatementSync
  private readonly markAppliedFilesStmt: StatementSync
  private readonly markRejectedStmt: StatementSync
  private readonly markRolledBackStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertTransactionStmt = db.prepare(
      'INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    this.insertFileStmt = db.prepare(
      'INSERT INTO change_transaction_files ' +
        '(transaction_id, relative_path, before_revision, before_bytes, proposed_revision, proposed_bytes) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.findTransactionStmt = db.prepare(
      'SELECT id, workspace_id, status, created_at, updated_at, applied_at, rejected_at, rolled_back_at ' +
        'FROM change_transactions WHERE id = ?'
    )
    this.findFilesStmt = db.prepare(
      'SELECT id, transaction_id, relative_path, before_revision, before_bytes, proposed_revision, proposed_bytes, applied_revision ' +
        'FROM change_transaction_files WHERE transaction_id = ? ORDER BY id ASC'
    )
    this.listRecentStmt = db.prepare(
      'SELECT id, workspace_id, status, created_at, updated_at, applied_at, rejected_at, rolled_back_at ' +
        'FROM change_transactions WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    this.markAppliedStmt = db.prepare(
      'UPDATE change_transactions SET status = ?, applied_at = ?, updated_at = ? WHERE id = ? AND status = ?'
    )
    this.markAppliedFilesStmt = db.prepare(
      'UPDATE change_transaction_files SET applied_revision = ? WHERE transaction_id = ?'
    )
    this.markRejectedStmt = db.prepare(
      'UPDATE change_transactions SET status = ?, rejected_at = ?, updated_at = ? WHERE id = ? AND status = ?'
    )
    this.markRolledBackStmt = db.prepare(
      'UPDATE change_transactions SET status = ?, rolled_back_at = ?, updated_at = ? WHERE id = ? AND status = ?'
    )
  }

  /**
   * Persists a transaction plus its file rows atomically: either every
   * row lands or none does. Returns the new transaction id.
   */
  createWithFiles(input: NewChangeTransaction, files: readonly NewChangeTransactionFile[]): number {
    let transactionId: number
    this.db.exec('BEGIN')
    try {
      const result = this.insertTransactionStmt.run(input.workspaceId, 'pending', input.now, input.now)
      transactionId = toRowId(result.lastInsertRowid)
      for (const file of files) {
        this.insertFileStmt.run(
          transactionId,
          file.relativePath,
          file.beforeRevision,
          file.beforeBytes,
          file.proposedRevision,
          file.proposedBytes
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return transactionId
  }

  /** Finds one transaction header by id, or undefined. */
  findTransaction(id: number): StoredChangeTransaction | undefined {
    const row: unknown = this.findTransactionStmt.get(id)
    return row === undefined ? undefined : mapTransaction(row)
  }

  /** All file rows for a transaction, insertion order. */
  findFiles(transactionId: number): StoredChangeTransactionFile[] {
    const rows: unknown = this.findFilesStmt.all(transactionId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored change transaction file rows are invalid')
    }
    return rows.map(mapFile)
  }

  /** Newest-first headers for one workspace, capped by limit. */
  listRecentForWorkspace(workspaceId: number, limit: number): StoredChangeTransaction[] {
    const rows: unknown = this.listRecentStmt.all(workspaceId, limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored change transaction rows are invalid')
    }
    return rows.map(mapTransaction)
  }

  /**
   * Marks pending → applied, recording the applied revision on every
   * file row. Returns false when the transaction was not pending.
   */
  markApplied(id: number, appliedRevision: string, now: number): boolean {
    this.db.exec('BEGIN')
    try {
      const result = this.markAppliedStmt.run('applied', now, now, id, 'pending')
      const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
      if (changed === 0) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.markAppliedFilesStmt.run(appliedRevision, id)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return true
  }

  /** Marks pending → rejected. Returns false when not pending. */
  markRejected(id: number, now: number): boolean {
    const result = this.markRejectedStmt.run('rejected', now, now, id, 'pending')
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /** Marks applied → rolled_back. Returns false when not applied. */
  markRolledBack(id: number, now: number): boolean {
    const result = this.markRolledBackStmt.run('rolled_back', now, now, id, 'applied')
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }
}
