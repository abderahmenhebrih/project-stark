import type { Migration } from '../types'

/**
 * Migration 1 — initial infrastructure.
 *
 * Creates only the key_value table required by the persistence
 * foundation. No feature tables (sessions, users, agents, …) belong here.
 */
export const migration001Initial: Migration = {
  version: 1,
  name: 'initial',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS key_value (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }
}
