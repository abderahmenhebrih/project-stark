import type { Migration } from '../types'

/**
 * Migration 3 — change transactions.
 *
 * Persistent reviewable file-change proposals. A transaction moves
 * pending → applied → rolled_back, or pending → rejected; both applied
 * and rejected states keep their exact byte checkpoints so history and
 * rollback survive restarts. Checkpoints and proposals are stored as
 * BLOBs so rollback restores exact bytes without reserialization.
 * Existing tables and rows are untouched.
 */
export const migration003ChangeTransactions: Migration = {
  version: 3,
  name: 'change-transactions',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_transactions (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'applied', 'rejected', 'rolled_back')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        rejected_at INTEGER,
        rolled_back_at INTEGER,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_transaction_files (
        id INTEGER PRIMARY KEY,
        transaction_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,

        before_revision TEXT NOT NULL,
        before_bytes BLOB NOT NULL,

        proposed_revision TEXT NOT NULL,
        proposed_bytes BLOB NOT NULL,

        applied_revision TEXT,

        FOREIGN KEY (transaction_id)
          REFERENCES change_transactions(id)
          ON DELETE CASCADE,

        UNIQUE (transaction_id, relative_path)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_change_transactions_workspace_created
      ON change_transactions(workspace_id, created_at DESC)
    `)
  }
}
