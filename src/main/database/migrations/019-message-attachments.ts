import type { Migration } from '../types'

/**
 * Migration 19 — Local chat attachments (images + files).
 *
 * `chat_attachments` holds one row per main-stored attachment:
 * normalized display metadata only (no source or storage paths —
 * the store path stays derivable main-side from the opaque id).
 * Attachments are inert: nothing here executes or forwards content.
 *
 * `message_attachments` links persisted messages to their
 * attachments. An attachment referenced by at least one message is
 * committed and must never be swept with composer drafts.
 *
 * Local-first invariant: attaching/sending never creates, mutates,
 * or deletes Workspace, session, transaction, capability, tool,
 * runtime, usage, provider-credential, or account rows. Idempotent.
 */
export const migration019MessageAttachments: Migration = {
  version: 19,
  name: 'message-attachments',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK (length(id) = 32),
        CHECK (kind IN ('image', 'file')),
        CHECK (size_bytes >= 0)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES coding_messages(id),
        attachment_id TEXT NOT NULL REFERENCES chat_attachments(id),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK (kind IN ('image', 'file')),
        CHECK (size_bytes >= 0)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
        ON message_attachments (message_id)
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment_id
        ON message_attachments (attachment_id)
    `)
  }
}
