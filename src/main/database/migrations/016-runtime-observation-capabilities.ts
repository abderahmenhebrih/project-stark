import type { Migration } from '../types'

/**
 * Migration 16 — Runtime observation capabilities (Stage 27).
 *
 * Backfills default-deny rows for the two new observation
 * capabilities (`runtime.observe`, `preview.inspect`) on every
 * workspace that already has agent settings. Existing policies are
 * never modified; missing rows are inserted only when absent
 * (`INSERT OR IGNORE` on the (workspace_id, capability) primary
 * key). Workspaces with no capability configuration keep relying on
 * synthesized default-deny. No new tables. Idempotent.
 */
export const migration016RuntimeObservationCapabilities: Migration = {
  version: 16,
  name: 'runtime-observation-capabilities',
  up(db): void {
    db.exec(`
      INSERT OR IGNORE INTO workspace_capability_policies
        (workspace_id, capability, mode, created_at, updated_at)
      SELECT workspace_id, 'runtime.observe', 'deny', 0, 0
      FROM workspace_agent_settings
    `)
    db.exec(`
      INSERT OR IGNORE INTO workspace_capability_policies
        (workspace_id, capability, mode, created_at, updated_at)
      SELECT workspace_id, 'preview.inspect', 'deny', 0, 0
      FROM workspace_agent_settings
    `)
  }
}
