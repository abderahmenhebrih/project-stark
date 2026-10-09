import type { Migration } from '../types'

/**
 * Migration 18 — Optional STARK cloud-account foundation (Stage 29).
 *
 * `cloud_account` is a singleton-style identity row (id=1): the
 * normalized Google/GitHub identity only — no tokens, no raw provider
 * payloads, no Workspace/session/project data.
 *
 * `cloud_auth_session` is a singleton row (id=1) holding ONLY
 * safeStorage-encrypted session material (BLOB). Plaintext tokens
 * never touch SQLite.
 *
 * Local-first invariant: signing in/out never creates, mutates, or
 * deletes Workspace, session, transaction, capability, tool, runtime,
 * usage, or provider-credential rows. Idempotent.
 */
export const migration018CloudAccount: Migration = {
  version: 18,
  name: 'cloud-account',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_account (
        id INTEGER PRIMARY KEY,
        cloud_user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        email TEXT,
        display_name TEXT,
        avatar_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_authenticated_at INTEGER NOT NULL,
        CHECK (id = 1),
        CHECK (provider IN ('google', 'github'))
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_auth_session (
        id INTEGER PRIMARY KEY,
        encrypted_session BLOB NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (id = 1)
      )
    `)
  }
}
