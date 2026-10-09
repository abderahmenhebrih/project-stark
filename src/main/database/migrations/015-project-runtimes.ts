import type { Migration } from '../types'

/**
 * Migration 15 — Managed project runtimes (Stage 26).
 *
 * `project_runtime_sessions` records at most one bounded long-lived
 * dev-server session per approved `runtime_start` action. The row is
 * the at-most-once reservation: it is inserted as `starting` in the
 * same transaction that consumes the approval, BEFORE any process
 * spawns, so a crash can never cause an automatic start after
 * restart. Only bounded rolling log tails persist (never unbounded
 * output). No PID is persisted (PID reuse would make post-restart
 * kills unsafe). Existing tables and rows are untouched.
 */
export const migration015ProjectRuntimes: Migration = {
  version: 15,
  name: 'project-runtimes',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_runtime_sessions (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        source_session_id INTEGER NOT NULL,
        orchestration_run_id INTEGER NOT NULL,
        approval_id INTEGER NOT NULL,
        program TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        preview_port INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        stdout_tail TEXT NOT NULL,
        stderr_tail TEXT NOT NULL,
        logs_truncated INTEGER NOT NULL,
        total_output_bytes INTEGER NOT NULL,
        stop_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (source_session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE,

        FOREIGN KEY (approval_id)
          REFERENCES worker_tool_approvals(id)
          ON DELETE CASCADE,

        UNIQUE(approval_id)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_runtime_workspace_created
      ON project_runtime_sessions(workspace_id, created_at DESC)
    `)
  }
}
