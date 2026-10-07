import type { Migration } from '../types'

/**
 * Migration 2 — workspaces.
 *
 * Creates the dedicated workspaces table. Workspaces are a core entity
 * later referenced by sessions, agents, terminals, and histories, so
 * they get their own table — never the key_value bag. Existing tables
 * and rows are untouched.
 */
export const migration002Workspaces: Migration = {
  version: 2,
  name: 'workspaces',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_last_opened_at
      ON workspaces(last_opened_at DESC)
    `)
  }
}
