import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ChangeSetKind } from '../../../shared/change-sets/types'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored change set ${what} is invalid`)
  }
  return numeric
}

/** Raw change-set row as stored (snake_case). */
export interface StoredChangeSet {
  readonly id: number
  readonly workspaceId: number
  readonly kind: ChangeSetKind
  readonly summary: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw change-set item row as stored (snake_case). */
export interface StoredChangeSetItem {
  readonly changeSetId: number
  readonly transactionId: number
  readonly ordinal: number
  readonly fileSummary: string
}

function mapChangeSet(row: unknown): StoredChangeSet {
  if (!isRecord(row)) {
    throw new DatabaseError('stored change set row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const kind = row['kind']
  const summary = row['summary']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof kind !== 'string' ||
    typeof summary !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored change set row is invalid')
  }
  return { id, workspaceId, kind: kind as ChangeSetKind, summary, createdAt, updatedAt }
}

function mapChangeSetItem(row: unknown): StoredChangeSetItem {
  if (!isRecord(row)) {
    throw new DatabaseError('stored change set item row is invalid')
  }
  const changeSetId = row['change_set_id']
  const transactionId = row['transaction_id']
  const ordinal = row['ordinal']
  const fileSummary = row['file_summary']
  if (
    typeof changeSetId !== 'number' ||
    typeof transactionId !== 'number' ||
    typeof ordinal !== 'number' ||
    typeof fileSummary !== 'string'
  ) {
    throw new DatabaseError('stored change set item row is invalid')
  }
  return { changeSetId, transactionId, ordinal, fileSummary }
}

export interface NewChangeSet {
  readonly workspaceId: number
  readonly kind: ChangeSetKind
  readonly summary: string
  readonly now: number
}

/** One child transaction plus its file row and set linkage. */
export interface NewChangeSetItem {
  readonly relativePath: string
  readonly beforeRevision: string
  readonly beforeBytes: Buffer
  readonly proposedRevision: string
  readonly proposedBytes: Buffer
  readonly ordinal: number
  readonly fileSummary: string
}

/**
 * Typed main-process repository over change_sets, change_set_items,
 * change_transactions, and change_transaction_files. Persistence only:
 * no validation, no filesystem, no provider logic. The aggregate
 * insert (set + all child transactions + files + items) runs inside
 * ONE SQLite transaction — either everything lands or nothing does.
 */
export class ChangeSetRepository {
  private readonly db: DatabaseSync
  private readonly insertSetStmt: StatementSync
  private readonly insertTransactionStmt: StatementSync
  private readonly insertFileStmt: StatementSync
  private readonly insertItemStmt: StatementSync
  private readonly findSetStmt: StatementSync
  private readonly findItemsStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly findSetForTransactionStmt: StatementSync
  private readonly linkExistingStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertSetStmt = db.prepare(
      'INSERT INTO change_sets (workspace_id, kind, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    this.insertTransactionStmt = db.prepare(
      'INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    this.insertFileStmt = db.prepare(
      'INSERT INTO change_transaction_files ' +
        '(transaction_id, relative_path, before_revision, before_bytes, proposed_revision, proposed_bytes) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.insertItemStmt = db.prepare(
      'INSERT INTO change_set_items (change_set_id, transaction_id, ordinal, file_summary) VALUES (?, ?, ?, ?)'
    )
    this.findSetStmt = db.prepare(
      'SELECT id, workspace_id, kind, summary, created_at, updated_at FROM change_sets WHERE id = ?'
    )
    this.findItemsStmt = db.prepare(
      'SELECT change_set_id, transaction_id, ordinal, file_summary FROM change_set_items ' +
        'WHERE change_set_id = ? ORDER BY ordinal ASC'
    )
    this.listRecentStmt = db.prepare(
      'SELECT id, workspace_id, kind, summary, created_at, updated_at FROM change_sets ' +
        'WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    this.findSetForTransactionStmt = db.prepare(
      'SELECT change_set_id, transaction_id, ordinal, file_summary FROM change_set_items WHERE transaction_id = ?'
    )
    this.linkExistingStmt = db.prepare(
      'INSERT INTO change_set_items (change_set_id, transaction_id, ordinal, file_summary) VALUES (?, ?, ?, ?)'
    )
  }

  /**
   * Atomically persists one Change Set with all of its child pending
   * transactions, file rows, and item links. Returns the new Change
   * Set id. The optional test-only fault injects a throw after the
   * given number of item inserts to prove no partial aggregate can
   * survive; production callers never pass it.
   */
  createChangeSet(
    input: NewChangeSet,
    items: readonly NewChangeSetItem[],
    fault?: { readonly failAfterItems: number }
  ): number {
    let changeSetId: number
    this.db.exec('BEGIN')
    try {
      const setResult = this.insertSetStmt.run(input.workspaceId, input.kind, input.summary, input.now, input.now)
      changeSetId = toRowId(setResult.lastInsertRowid, 'change set')
      let inserted = 0
      for (const item of items) {
        const txResult = this.insertTransactionStmt.run(input.workspaceId, 'pending', input.now, input.now)
        const transactionId = toRowId(txResult.lastInsertRowid, 'transaction')
        this.insertFileStmt.run(
          transactionId,
          item.relativePath,
          item.beforeRevision,
          item.beforeBytes,
          item.proposedRevision,
          item.proposedBytes
        )
        this.insertItemStmt.run(changeSetId, transactionId, item.ordinal, item.fileSummary)
        inserted += 1
        if (fault !== undefined && inserted > fault.failAfterItems) {
          throw new DatabaseError('injected change-set persistence fault')
        }
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
    return changeSetId
  }

  /** Finds one Change Set header by id, or undefined. */
  findChangeSetById(id: number): StoredChangeSet | undefined {
    const row: unknown = this.findSetStmt.get(id)
    return row === undefined ? undefined : mapChangeSet(row)
  }

  /** All item links for one Change Set, ordinal order. */
  findItems(changeSetId: number): StoredChangeSetItem[] {
    const rows: unknown = this.findItemsStmt.all(changeSetId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored change set item rows are invalid')
    }
    return rows.map(mapChangeSetItem)
  }

  /** Newest-first Change Set headers for one workspace, capped by limit. */
  listRecentForWorkspace(workspaceId: number, limit: number): StoredChangeSet[] {
    const rows: unknown = this.listRecentStmt.all(workspaceId, limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored change set rows are invalid')
    }
    return rows.map(mapChangeSet)
  }

  /**
   * Item link for one transaction, or undefined when the transaction
   * is not grouped in any set. New SELECT only — no schema change.
   */
  findSetForTransaction(transactionId: number): StoredChangeSetItem | undefined {
    const row: unknown = this.findSetForTransactionStmt.get(transactionId)
    return row === undefined ? undefined : mapChangeSetItem(row)
  }

  /**
   * Atomically persists one Change Set linking already-existing
   * pending transactions (Step 3 mixed binary+text grouping). Either
   * the set plus every link lands or nothing does. Returns the new
   * Change Set id. Callers validate membership first; UNIQUE
   * violations (already-grouped transaction) fail here.
   */
  createChangeSetForExisting(
    input: NewChangeSet,
    items: readonly { readonly transactionId: number; readonly ordinal: number; readonly fileSummary: string }[]
  ): number {
    let changeSetId: number
    this.db.exec('BEGIN')
    try {
      const setResult = this.insertSetStmt.run(input.workspaceId, input.kind, input.summary, input.now, input.now)
      changeSetId = toRowId(setResult.lastInsertRowid, 'change set')
      for (const item of items) {
        this.linkExistingStmt.run(changeSetId, item.transactionId, item.ordinal, item.fileSummary)
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
    return changeSetId
  }
}
