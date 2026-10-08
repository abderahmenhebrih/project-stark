import type { Migration } from '../types'

/**
 * Migration 13 — Read-only Worker tools (Stage 23).
 *
 * `worker_tool_approvals` holds one exact per-action approval request
 * (statuses validated in service, never CHECK-locked).
 * `worker_tool_events` is the immutable tool audit.
 * `worker_tool_run_state` persists bounded normalized Worker
 * conversation state so approval/resume survives restart with no
 * provider-native IDs, credentials, or raw SDK objects.
 * Existing tables and rows are untouched.
 */
export const migration013WorkerTools: Migration = {
  version: 13,
  name: 'worker-tools',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_tool_approvals (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        orchestration_run_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        capability TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        consumed_at INTEGER,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_tool_events (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        orchestration_run_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        capability TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        result_payload TEXT NOT NULL,
        result_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        approval_id INTEGER,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE,

        FOREIGN KEY (approval_id)
          REFERENCES worker_tool_approvals(id)
          ON DELETE SET NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_tool_run_state (
        orchestration_run_id INTEGER PRIMARY KEY,
        tool_call_count INTEGER NOT NULL,
        worker_instruction TEXT NOT NULL,
        active_user_message_id INTEGER NOT NULL,
        continuity_used INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE,

        FOREIGN KEY (active_user_message_id)
          REFERENCES coding_messages(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_worker_tool_approvals_session_status
      ON worker_tool_approvals(session_id, status, created_at DESC)
    `)
  }
}
