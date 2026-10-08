import type { Migration } from '../types'

/**
 * Migration 14 — Worker terminal command executions (Stage 25).
 *
 * `worker_command_executions` records at most one bounded non-interactive
 * external-process execution per approved `terminal_execute` action.
 * The row is the at-most-once reservation: it is inserted as `launching`
 * in the same transaction that consumes the approval, BEFORE any process
 * spawns, so a crash can never cause an automatic re-execution. No PID is
 * persisted (PID reuse would make post-restart kills unsafe). Existing
 * tables and rows are untouched.
 */
export const migration014WorkerCommandExecutions: Migration = {
  version: 14,
  name: 'worker-command-executions',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_command_executions (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        orchestration_run_id INTEGER NOT NULL,
        approval_id INTEGER NOT NULL,
        program TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        output_bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,

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
          ON DELETE CASCADE,

        UNIQUE(approval_id)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_worker_command_run_created
      ON worker_command_executions(orchestration_run_id, created_at)
    `)
  }
}
