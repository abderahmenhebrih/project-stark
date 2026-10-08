import type { Migration } from '../types'

/**
 * Migration 7 — persistent AI multi-file proposal Change Sets.
 *
 * `change_sets` groups one proposal's pending Stage 9 transactions:
 * workspace owner, creation kind, global summary, timestamps. Group
 * state is derived from child transaction statuses (never persisted).
 * `change_set_items` links each set to its transactions in ordinal
 * order with a per-file summary; one transaction belongs to at most
 * one set. Rows cascade from their set/transaction; the index serves
 * newest-first history loads per workspace. Existing tables and rows
 * are untouched.
 */
export const migration007ChangeSets: Migration = {
  version: 7,
  name: 'change-sets',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_sets (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_set_items (
        change_set_id INTEGER NOT NULL,
        transaction_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        file_summary TEXT NOT NULL,

        PRIMARY KEY (change_set_id, transaction_id),

        FOREIGN KEY (change_set_id)
          REFERENCES change_sets(id)
          ON DELETE CASCADE,

        FOREIGN KEY (transaction_id)
          REFERENCES change_transactions(id)
          ON DELETE CASCADE,

        UNIQUE (change_set_id, ordinal),
        UNIQUE (transaction_id)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_change_sets_workspace_created
      ON change_sets(workspace_id, created_at DESC)
    `)
  }
}
