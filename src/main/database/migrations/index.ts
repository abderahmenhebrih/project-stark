import type { DatabaseSync } from 'node:sqlite'
import { DatabaseError, MigrationError } from '../errors'
import type { Migration } from '../types'
import { migration001Initial } from './001-initial'
import { migration002Workspaces } from './002-workspaces'
import { migration003ChangeTransactions } from './003-change-transactions'
import { migration004CodingSessions } from './004-coding-sessions'
import { migration005AiProviders } from './005-ai-providers'
import { migration006MessageContext } from './006-message-context'

/**
 * Ordered migration registry. Append-only: add new migrations to the end
 * of this list in ascending version order. Never edit an applied migration.
 */
export const migrations: readonly Migration[] = [
  migration001Initial,
  migration002Workspaces,
  migration003ChangeTransactions,
  migration004CodingSessions,
  migration005AiProviders,
  migration006MessageContext
]

/**
 * Validates a migration list definition. Rejects duplicate versions,
 * non-integer or non-positive versions, and lists that are not already
 * in strictly ascending order — fail fast instead of running a
 * malformed sequence.
 */
export function validateMigrations(list: readonly Migration[]): void {
  const seen = new Set<number>()
  let previous = 0
  for (const migration of list) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new DatabaseError(`migration '${migration.name}' has an invalid version (must be a positive integer)`)
    }
    if (seen.has(migration.version)) {
      throw new DatabaseError(`duplicate migration version ${migration.version}`)
    }
    seen.add(migration.version)
    if (migration.version <= previous) {
      throw new DatabaseError(`migrations are not in ascending order at version ${migration.version}`)
    }
    previous = migration.version
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads the canonical schema version stored via PRAGMA user_version.
 */
export function getUserVersion(db: DatabaseSync): number {
  const row: unknown = db.prepare('PRAGMA user_version').get()
  if (!isRecord(row) || typeof row['user_version'] !== 'number') {
    throw new DatabaseError('unable to read database schema version')
  }
  return row['user_version']
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`)
}

/**
 * Applies every pending migration in order and returns the resulting
 * schema version. Each migration runs inside its own transaction together
 * with the user_version bump, so a failed migration rolls back completely
 * and is never falsely marked as applied. Already-applied migrations are
 * skipped, making repeat runs idempotent.
 */
export function runMigrations(db: DatabaseSync, list: readonly Migration[]): number {
  validateMigrations(list)
  const current = getUserVersion(db)
  for (const migration of list) {
    if (migration.version <= current) {
      continue
    }
    db.exec('BEGIN')
    try {
      migration.up(db)
      setUserVersion(db, migration.version)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Best effort: the original migration error below is what matters.
      }
      throw new MigrationError(migration.version, migration.name, { cause: error })
    }
  }
  return getUserVersion(db)
}
