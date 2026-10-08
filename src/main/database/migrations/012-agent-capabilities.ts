import type { Migration } from '../types'

/**
 * Migration 12 — Workspace agent capabilities (Stage 22).
 *
 * `workspace_agent_settings` holds the per-workspace master kill
 * switch (absent row means disabled). `workspace_capability_policies`
 * holds one mode per known capability per workspace — validated in
 * CapabilityService, never CHECK-locked here. No approval rows, no
 * audit rows, no secrets, no commands. Existing tables untouched.
 */
export const migration012AgentCapabilities: Migration = {
  version: 12,
  name: 'agent-capabilities',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_agent_settings (
        workspace_id INTEGER PRIMARY KEY,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_capability_policies (
        workspace_id INTEGER NOT NULL,
        capability TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        PRIMARY KEY (workspace_id, capability),

        FOREIGN KEY (workspace_id)
          REFERENCES workspaces(id)
          ON DELETE CASCADE
      )
    `)
  }
}
