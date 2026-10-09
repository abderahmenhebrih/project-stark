import type { Migration } from '../types'

/**
 * Migration 17 — Local AI usage awareness (Stage 28).
 *
 * `ai_usage_events` is STARK's own outbound-call ledger: one row per
 * provider attempt STARK initiates (success, failure, or reserved
 * attempt interrupted by crash). Metadata and counters only — never
 * prompts, results, keys, or bodies.
 *
 * `ai_usage_settings` (singleton id=1) holds the Heart threshold
 * routing opt-in, default OFF so existing Work behavior is unchanged.
 *
 * `ai_usage_limits` holds user-defined local routing thresholds
 * (never provider quotas). `ai_heart_threshold_alternates` holds at
 * most one alternate per Heart route key.
 * `ai_usage_route_decisions` is the immutable per-run routing audit.
 * Existing tables and rows are untouched. Idempotent.
 */
export const migration017AiUsageThresholds: Migration = {
  version: 17,
  name: 'ai-usage-thresholds',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        operation TEXT NOT NULL,
        role TEXT,
        workspace_id INTEGER,
        session_id INTEGER,
        orchestration_run_id INTEGER,
        status TEXT NOT NULL,
        failure_category TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE SET NULL,

        FOREIGN KEY (session_id)
          REFERENCES coding_sessions(id)
          ON DELETE SET NULL,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE SET NULL
      )
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_model_created
      ON ai_usage_events(provider_id, model, created_at DESC)
    `)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_usage_run
      ON ai_usage_events(orchestration_run_id, created_at)
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_settings (
        id INTEGER PRIMARY KEY,
        heart_threshold_routing_enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_limits (
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        max_calls_24h INTEGER,
        max_total_tokens_24h INTEGER,
        switch_at_percent INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        PRIMARY KEY (provider_id, model)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_heart_threshold_alternates (
        route_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_route_decisions (
        id INTEGER PRIMARY KEY,
        orchestration_run_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        route_key TEXT NOT NULL,
        base_provider_id TEXT NOT NULL,
        base_model TEXT NOT NULL,
        selected_provider_id TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        decision TEXT NOT NULL,
        calls_24h INTEGER NOT NULL,
        tokens_24h INTEGER,
        token_telemetry_complete INTEGER NOT NULL,
        max_calls_24h INTEGER,
        max_total_tokens_24h INTEGER,
        switch_at_percent INTEGER,
        calls_triggered INTEGER NOT NULL,
        tokens_triggered INTEGER NOT NULL,
        snapshot_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (orchestration_run_id)
          REFERENCES orchestration_runs(id)
          ON DELETE CASCADE,

        UNIQUE (orchestration_run_id, role)
      )
    `)
    // No settings/limit/alternate seed rows: an absent configuration
    // reads as threshold routing OFF with no limits and no alternates,
    // so existing Work behavior is unchanged by migration alone.
  }
}
