import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asEnabled(value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw new DatabaseError('stored capability settings row is invalid')
  }
  return value === 1
}

/** Raw workspace agent settings row. */
export interface StoredWorkspaceAgentSettings {
  readonly workspaceId: number
  readonly enabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw capability policy row. */
export interface StoredCapabilityPolicy {
  readonly workspaceId: number
  readonly capability: string
  readonly mode: string
  readonly createdAt: number
  readonly updatedAt: number
}

function mapSettings(row: unknown): StoredWorkspaceAgentSettings {
  if (!isRecord(row)) {
    throw new DatabaseError('stored capability settings row is invalid')
  }
  const workspaceId = row['workspace_id']
  const enabled = row['enabled']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (typeof workspaceId !== 'number' || typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    throw new DatabaseError('stored capability settings row is invalid')
  }
  return { workspaceId, enabled: asEnabled(enabled), createdAt, updatedAt }
}

function mapPolicy(row: unknown): StoredCapabilityPolicy {
  if (!isRecord(row)) {
    throw new DatabaseError('stored capability policy row is invalid')
  }
  const workspaceId = row['workspace_id']
  const capability = row['capability']
  const mode = row['mode']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof workspaceId !== 'number' ||
    typeof capability !== 'string' ||
    typeof mode !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored capability policy row is invalid')
  }
  return { workspaceId, capability, mode, createdAt, updatedAt }
}

/**
 * Typed main-process repository over workspace_agent_settings and
 * workspace_capability_policies. Persistence only: no validation
 * beyond row shapes, no provider/tool/filesystem logic, no secrets.
 * Complete config saves run in ONE SQLite transaction with
 * replacement semantics. Fault injection is test-only.
 */
export class CapabilityRepository {
  private readonly db: DatabaseSync
  private readonly findSettingsStmt: StatementSync
  private readonly upsertSettingsStmt: StatementSync
  private readonly listPoliciesStmt: StatementSync
  private readonly upsertPolicyStmt: StatementSync
  private readonly deletePolicyStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.findSettingsStmt = db.prepare(
      'SELECT workspace_id, enabled, created_at, updated_at FROM workspace_agent_settings WHERE workspace_id = ?'
    )
    this.upsertSettingsStmt = db.prepare(
      'INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
    )
    this.listPoliciesStmt = db.prepare(
      'SELECT workspace_id, capability, mode, created_at, updated_at FROM workspace_capability_policies WHERE workspace_id = ?'
    )
    this.upsertPolicyStmt = db.prepare(
      'INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(workspace_id, capability) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at'
    )
    this.deletePolicyStmt = db.prepare(
      'DELETE FROM workspace_capability_policies WHERE workspace_id = ? AND capability = ?'
    )
  }

  /** Settings row for one workspace, or undefined when never configured. */
  findSettings(workspaceId: number): StoredWorkspaceAgentSettings | undefined {
    const row: unknown = this.findSettingsStmt.get(workspaceId)
    return row === undefined ? undefined : mapSettings(row)
  }

  /** All policy rows for one workspace. */
  listPolicies(workspaceId: number): StoredCapabilityPolicy[] {
    const rows: unknown = this.listPoliciesStmt.all(workspaceId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored capability policy rows are invalid')
    }
    return rows.map(mapPolicy)
  }

  /**
   * Atomically replaces the complete workspace configuration:
   * settings plus exactly the given policies (stale rows removed).
   * Either everything lands or nothing does.
   */
  saveConfig(
    input: {
      workspaceId: number
      enabled: boolean
      policies: { capability: string; mode: string }[]
      now: number
    },
    fault?: { readonly failAfterPolicies: number }
  ): void {
    this.db.exec('BEGIN')
    try {
      this.upsertSettingsStmt.run(input.workspaceId, input.enabled ? 1 : 0, input.now, input.now)
      const wanted = new Set(input.policies.map((entry) => entry.capability))
      for (const existing of this.listPolicies(input.workspaceId)) {
        if (!wanted.has(existing.capability)) {
          this.deletePolicyStmt.run(input.workspaceId, existing.capability)
        }
      }
      let inserted = 0
      for (const entry of input.policies) {
        this.upsertPolicyStmt.run(input.workspaceId, entry.capability, entry.mode, input.now, input.now)
        inserted += 1
        if (fault !== undefined && inserted > fault.failAfterPolicies) {
          throw new DatabaseError('injected capability save fault')
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
  }
}
