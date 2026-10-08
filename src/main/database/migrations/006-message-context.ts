import type { Migration } from '../types'

/**
 * Migration 6 — per-message explicit context items.
 *
 * `message_context_items` records exactly the context attachments
 * that were sent with a user message: kind, display label, optional
 * repo-relative path and 1-based line range, exact content snapshot,
 * and byte size. Rows cascade from their message; the index serves
 * history loads per message. Existing tables and rows are untouched.
 */
export const migration006MessageContext: Migration = {
  version: 6,
  name: 'message-context',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_context_items (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('file-excerpt', 'whole-file', 'search-match', 'manual-note')),
        label TEXT NOT NULL,
        relative_path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        content TEXT NOT NULL,
        content_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (message_id)
          REFERENCES coding_messages(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_context_message_id
      ON message_context_items(message_id, id)
    `)
  }
}
