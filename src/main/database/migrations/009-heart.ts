import type { Migration } from '../types'

/**
 * Migration 9 — Heart model-routing configuration plus per-step
 * model audit for orchestration runs.
 *
 * `ai_heart_settings` holds exactly one active row (id = 1) with the
 * Worker routing mode. `ai_heart_assignments` maps (role, route_key)
 * to provider/model pairs — kinds and combinations are validated in
 * HeartService, never CHECK-locked here. `orchestration_step_models`
 * records which provider/model/route actually performed each
 * provider-backed step, with the Brain-requested profile on Worker
 * rows; historical Stage 18 steps without rows remain valid.
 * Existing tables and rows are untouched.
 */
export const migration009Heart: Migration = {
  version: 9,
  name: 'heart',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_heart_settings (
        id INTEGER PRIMARY KEY,
        worker_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_heart_assignments (
        role TEXT NOT NULL,
        route_key TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        PRIMARY KEY (role, route_key)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_step_models (
        step_id INTEGER PRIMARY KEY,
        role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        route_key TEXT NOT NULL,
        requested_profile TEXT,

        FOREIGN KEY (step_id)
          REFERENCES orchestration_steps(id)
          ON DELETE CASCADE
      )
    `)
  }
}
