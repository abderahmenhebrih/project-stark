import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Workspace } from '../../../shared/workspace/types'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Maps a raw SQLite row onto the shared Workspace contract. */
function mapRow(row: unknown): Workspace {
  if (!isRecord(row)) {
    throw new DatabaseError('stored workspace row is invalid')
  }
  const id = row['id']
  const rootPath = row['root_path']
  const displayName = row['display_name']
  const createdAt = row['created_at']
  const lastOpenedAt = row['last_opened_at']
  if (
    typeof id !== 'number' ||
    typeof rootPath !== 'string' ||
    typeof displayName !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof lastOpenedAt !== 'number'
  ) {
    throw new DatabaseError('stored workspace row is invalid')
  }
  return { id, rootPath, displayName, createdAt, lastOpenedAt }
}

export interface NewWorkspace {
  readonly rootPath: string
  readonly displayName: string
  readonly now: number
}

/**
 * Typed main-process repository over the workspaces table.
 *
 * Consumers never see SQL: every statement is prepared once and all
 * values use parameter binding. Rows are mapped onto the shared
 * Workspace contract; malformed rows surface as DatabaseError instead
 * of unpredictable data.
 */
export class WorkspaceRepository {
  private readonly insertStmt: StatementSync
  private readonly findByIdStmt: StatementSync
  private readonly findByRootPathStmt: StatementSync
  private readonly touchStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly mostRecentStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      'INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES (?, ?, ?, ?)'
    )
    this.findByIdStmt = db.prepare(
      'SELECT id, root_path, display_name, created_at, last_opened_at FROM workspaces WHERE id = ?'
    )
    this.findByRootPathStmt = db.prepare(
      'SELECT id, root_path, display_name, created_at, last_opened_at FROM workspaces WHERE root_path = ?'
    )
    this.touchStmt = db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?')
    this.listRecentStmt = db.prepare(
      'SELECT id, root_path, display_name, created_at, last_opened_at FROM workspaces ' +
        'ORDER BY last_opened_at DESC LIMIT ?'
    )
    this.mostRecentStmt = db.prepare(
      'SELECT id, root_path, display_name, created_at, last_opened_at FROM workspaces ' +
        'ORDER BY last_opened_at DESC LIMIT 1'
    )
  }

  /** Inserts a workspace. The UNIQUE root_path constraint rejects duplicates. */
  create(input: NewWorkspace): Workspace {
    const result = this.insertStmt.run(input.rootPath, input.displayName, input.now, input.now)
    const id = result.lastInsertRowid
    const numericId = typeof id === 'bigint' ? Number(id) : id
    return {
      id: numericId,
      rootPath: input.rootPath,
      displayName: input.displayName,
      createdAt: input.now,
      lastOpenedAt: input.now
    }
  }

  /** Finds a workspace by its internal ID, or undefined. */
  findById(id: number): Workspace | undefined {
    const row: unknown = this.findByIdStmt.get(id)
    return row === undefined ? undefined : mapRow(row)
  }

  /** Finds a workspace by its exact canonical root path, or undefined. */
  findByRootPath(rootPath: string): Workspace | undefined {
    const row: unknown = this.findByRootPathStmt.get(rootPath)
    return row === undefined ? undefined : mapRow(row)
  }

  /** Refreshes last_opened_at for a workspace. */
  touchLastOpened(id: number, now: number): void {
    this.touchStmt.run(now, id)
  }

  /** Most recently opened first, up to limit entries. */
  listRecent(limit: number): Workspace[] {
    const rows: unknown = this.listRecentStmt.all(limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored workspace rows are invalid')
    }
    return rows.map(mapRow)
  }

  /** The single most recently opened workspace, or undefined. */
  getMostRecentlyOpened(): Workspace | undefined {
    const row: unknown = this.mostRecentStmt.get()
    return row === undefined ? undefined : mapRow(row)
  }
}
