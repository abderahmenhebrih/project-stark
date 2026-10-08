import type { Migration } from '../types'

/**
 * Migration 11 — Continuity Recovery (Stage 21).
 *
 * `ai_recovery_settings` holds exactly one row (id = 1) with the
 * recovery mode. `ai_recovery_assignments` maps recovery roles
 * (ask/brain/worker) to provider/model pairs — validated in
 * RecoveryService, never CHECK-locked here. `ai_recovery_events`
 * proves one source request received at most one automatic handoff,
 * and `ai_recovery_event_routes` records the actual recovery routes
 * used. No credentials, endpoints, or billing data anywhere.
 * Existing tables and rows are untouched.
 */
export const migration011RecoveryContinuity: Migration = {
  version: 11,
  name: 'recovery-continuity',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_recovery_settings (
        id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_recovery_assignments (
        role TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_recovery_events (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        source_session_id INTEGER NOT NULL,
        target_session_id INTEGER NOT NULL,
        source_message_id INTEGER NOT NULL,
        looplink_handoff_id INTEGER NOT NULL,
        operation TEXT NOT NULL,
        failure_category TEXT NOT NULL,
        policy_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        target_user_message_id INTEGER,
        target_assistant_message_id INTEGER,
        target_run_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE,

        FOREIGN KEY (source_session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (target_session_id)
          REFERENCES coding_sessions(id)
          ON DELETE CASCADE,

        FOREIGN KEY (source_message_id)
          REFERENCES coding_messages(id)
          ON DELETE CASCADE,

        FOREIGN KEY (looplink_handoff_id)
          REFERENCES looplink_handoffs(id)
          ON DELETE CASCADE,

        FOREIGN KEY (target_user_message_id)
          REFERENCES coding_messages(id)
          ON DELETE SET NULL,

        FOREIGN KEY (target_assistant_message_id)
          REFERENCES coding_messages(id)
          ON DELETE SET NULL,

        FOREIGN KEY (target_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE SET NULL,

        UNIQUE (source_session_id, source_message_id, operation),
        UNIQUE (looplink_handoff_id)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_recovery_event_routes (
        recovery_event_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,

        PRIMARY KEY (recovery_event_id, role),

        FOREIGN KEY (recovery_event_id)
          REFERENCES ai_recovery_events(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recovery_events_target
      ON ai_recovery_events(target_session_id)
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recovery_events_source
      ON ai_recovery_events(source_session_id, source_message_id)
    `)
  }
}
