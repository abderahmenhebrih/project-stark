import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { CorruptValueError, DatabaseError } from '../errors'
import { assertJsonValue } from '../json'
import type { JsonValue } from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireNonEmptyKey(key: string): void {
  if (key === '') {
    throw new DatabaseError('key must not be empty')
  }
}

/**
 * Typed main-process repository over the key_value table.
 *
 * Consumers never see SQL: every statement is prepared once and all keys
 * use parameter binding. Values are stored as JSON text; reads revalidate
 * the decoded payload so corrupt rows surface as CorruptValueError
 * instead of unpredictable data.
 */
export class KeyValueRepository {
  private readonly selectStmt: StatementSync
  private readonly upsertStmt: StatementSync
  private readonly deleteStmt: StatementSync
  private readonly existsStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.selectStmt = db.prepare('SELECT value FROM key_value WHERE key = ?')
    this.upsertStmt = db.prepare(
      'INSERT INTO key_value (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    this.deleteStmt = db.prepare('DELETE FROM key_value WHERE key = ?')
    this.existsStmt = db.prepare('SELECT 1 AS found FROM key_value WHERE key = ?')
  }

  /** Returns the stored value, or undefined when the key is absent. */
  get(key: string): JsonValue | undefined {
    requireNonEmptyKey(key)
    const row: unknown = this.selectStmt.get(key)
    if (row === undefined) {
      return undefined
    }
    if (!isRecord(row) || typeof row['value'] !== 'string') {
      throw new CorruptValueError(key)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row['value']) as unknown
    } catch (error) {
      throw new CorruptValueError(key, { cause: error })
    }
    try {
      assertJsonValue(parsed, `stored value for key '${key}'`)
    } catch (error) {
      throw new CorruptValueError(key, { cause: error })
    }
    return parsed
  }

  /** Inserts or overwrites a value. Only JSON-safe values are accepted. */
  set(key: string, value: JsonValue): void {
    requireNonEmptyKey(key)
    assertJsonValue(value, 'value')
    this.upsertStmt.run(key, JSON.stringify(value), Date.now())
  }

  /** Returns true when the key exists. */
  has(key: string): boolean {
    requireNonEmptyKey(key)
    return this.existsStmt.get(key) !== undefined
  }

  /** Deletes a key. Returns true when a row was actually removed. */
  delete(key: string): boolean {
    requireNonEmptyKey(key)
    const result = this.deleteStmt.run(key)
    const changes = result.changes
    return typeof changes === 'bigint' ? changes > 0n : changes > 0
  }
}
