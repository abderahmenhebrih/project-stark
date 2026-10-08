import type { Migration } from '../types'

/**
 * Migration 8 — bounded Brain orchestration runs.
 *
 * `orchestration_runs` records one Brain → optional Worker → optional
 * Brain synthesis execution per trailing user message: workspace and
 * session owners, the user message answered, lifecycle status, the
 * Brain plan decision, its user-safe summary, the final assistant
 * message, and a safe error category on failure. `orchestration_steps`
 * holds the bounded per-kind artifacts in ordinal order. Statuses and
 * kinds are intentionally not CHECK-locked so future stages can extend
 * them without a migration. Existing tables and rows are untouched.
 */
export const migration008OrchestrationRuns: Migration = {
  version: 8,
  name: 'orchestration-runs',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        user_message_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        action TEXT,
        plan_summary TEXT,
        final_message_id INTEGER,
        error_category TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (user_message_id)
          REFERENCES coding_messages(id)
          ON DELETE CASCADE,

        FOREIGN KEY (final_message_id)
          REFERENCES coding_messages(id)
          ON DELETE SET NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_steps (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        instruction TEXT,
        output TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE,

        UNIQUE (run_id, ordinal)
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_session_created
      ON orchestration_runs(session_id, created_at DESC)
    `)
  }
}
