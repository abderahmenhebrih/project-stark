import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Raw Heart settings row (singleton id = 1). */
export interface StoredHeartSettings {
  readonly workerMode: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw Heart assignment row. */
export interface StoredHeartAssignment {
  readonly role: string
  readonly routeKey: string
  readonly providerId: string
  readonly model: string
  readonly createdAt: number
  readonly updatedAt: number
}

function mapSettings(row: unknown): StoredHeartSettings {
  if (!isRecord(row)) {
    throw new DatabaseError('stored heart settings row is invalid')
  }
  const workerMode = row['worker_mode']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (typeof workerMode !== 'string' || typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    throw new DatabaseError('stored heart settings row is invalid')
  }
  return { workerMode, createdAt, updatedAt }
}

function mapAssignment(row: unknown): StoredHeartAssignment {
  if (!isRecord(row)) {
    throw new DatabaseError('stored heart assignment row is invalid')
  }
  const role = row['role']
  const routeKey = row['route_key']
  const providerId = row['provider_id']
  const model = row['model']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof role !== 'string' ||
    typeof routeKey !== 'string' ||
    typeof providerId !== 'string' ||
    typeof model !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored heart assignment row is invalid')
  }
  return { role, routeKey, providerId, model, createdAt, updatedAt }
}

/**
 * Typed main-process repository over ai_heart_settings and
 * ai_heart_assignments. Persistence only: no validation beyond row
 * shapes, no provider logic, no credentials anywhere. Complete config
 * saves run in ONE SQLite transaction. The optional fault injects a
 * throw mid-save for atomicity tests only.
 */
export class HeartRepository {
  private readonly db: DatabaseSync
  private readonly findSettingsStmt: StatementSync
  private readonly upsertSettingsStmt: StatementSync
  private readonly listAssignmentsStmt: StatementSync
  private readonly upsertAssignmentStmt: StatementSync
  private readonly deleteAssignmentStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.findSettingsStmt = db.prepare('SELECT worker_mode, created_at, updated_at FROM ai_heart_settings WHERE id = 1')
    this.upsertSettingsStmt = db.prepare(
      'INSERT INTO ai_heart_settings (id, worker_mode, created_at, updated_at) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET worker_mode = excluded.worker_mode, updated_at = excluded.updated_at'
    )
    this.listAssignmentsStmt = db.prepare(
      'SELECT role, route_key, provider_id, model, created_at, updated_at FROM ai_heart_assignments'
    )
    this.upsertAssignmentStmt = db.prepare(
      'INSERT INTO ai_heart_assignments (role, route_key, provider_id, model, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(role, route_key) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, ' +
        'updated_at = excluded.updated_at'
    )
    this.deleteAssignmentStmt = db.prepare('DELETE FROM ai_heart_assignments WHERE role = ? AND route_key = ?')
  }

  /** Active settings row, or undefined when Heart was never configured. */
  findSettings(): StoredHeartSettings | undefined {
    const row: unknown = this.findSettingsStmt.get()
    return row === undefined ? undefined : mapSettings(row)
  }

  /** All stored assignments. */
  listAssignments(): StoredHeartAssignment[] {
    const rows: unknown = this.listAssignmentsStmt.all()
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored heart assignment rows are invalid')
    }
    return rows.map(mapAssignment)
  }

  /**
   * Atomically replaces the complete Heart configuration: settings
   * plus exactly the given assignments (stale override rows removed).
   */
  saveConfig(
    input: {
      workerMode: string
      assignments: { role: string; routeKey: string; providerId: string; model: string }[]
      now: number
    },
    fault?: { readonly failAfterAssignments: number }
  ): void {
    this.db.exec('BEGIN')
    try {
      this.upsertSettingsStmt.run(input.workerMode, input.now, input.now)
      const wanted = new Set(input.assignments.map((entry) => `${entry.role}\0${entry.routeKey}`))
      for (const existing of this.listAssignments()) {
        if (!wanted.has(`${existing.role}\0${existing.routeKey}`)) {
          this.deleteAssignmentStmt.run(existing.role, existing.routeKey)
        }
      }
      let inserted = 0
      for (const entry of input.assignments) {
        this.upsertAssignmentStmt.run(entry.role, entry.routeKey, entry.providerId, entry.model, input.now, input.now)
        inserted += 1
        if (fault !== undefined && inserted > fault.failAfterAssignments) {
          throw new DatabaseError('injected heart save fault')
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
  }
}
