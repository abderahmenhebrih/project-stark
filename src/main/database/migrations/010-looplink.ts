import type { Migration } from '../types'

/**
 * Migration 10 — Looplink continuity handoffs.
 *
 * `looplink_handoffs` records one immutable bounded snapshot per
 * explicit continuation: workspace owner, source and target
 * sessions, optional source orchestration run, lifecycle status,
 * deterministic payload text with its byte size and SHA-256 hash,
 * omission counters, and terminal timestamps. One target session
 * carries at most one handoff. Statuses are intentionally not
 * CHECK-locked. Existing tables and rows are untouched.
 */
export const migration010Looplink: Migration = {
  version: 10,
  name: 'looplink',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS looplink_handoffs (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        source_session_id INTEGER NOT NULL,
        target_session_id INTEGER NOT NULL,
        source_run_id INTEGER,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        omitted_message_count INTEGER NOT NULL,
        omitted_context_count INTEGER NOT NULL,
        worker_result_omitted INTEGER NOT NULL,
        omitted_change_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        dismissed_at INTEGER,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (source_session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (target_session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (source_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE SET NULL,

        UNIQUE (target_session_id)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_looplink_source_created
      ON looplink_handoffs(source_session_id, created_at DESC)
    `)
  }
}
