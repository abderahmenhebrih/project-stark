import type { Migration } from '../types'

/**
 * Migration 4 — persistent coding sessions.
 *
 * Workspace-scoped conversations: coding_sessions holds one row per
 * session (deterministic local titles, recency timestamps) and
 * coding_messages holds append-only user/assistant rows. The role
 * CHECK admits 'user' and 'assistant' because later provider/Brain
 * stages will append assistant replies; Stage 13 writes user rows
 * only. Both tables cascade from workspaces/session rows, and the
 * indexes serve the two hot reads: recent sessions per workspace and
 * message pages per session. Existing tables and rows are untouched.
 */
export const migration004CodingSessions: Migration = {
  version: 4,
  name: 'coding-sessions',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coding_sessions (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coding_sessions_workspace_updated
      ON coding_sessions(workspace_id, updated_at DESC)
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS coding_messages (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,

        role TEXT NOT NULL
          CHECK (role IN ('user', 'assistant')),

        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coding_messages_session_id
      ON coding_messages(session_id, id)
    `)
  }
}
