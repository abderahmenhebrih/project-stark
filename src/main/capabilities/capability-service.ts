import type {
  AgentCapability,
  CapabilityPolicyMode,
  UpdateWorkspaceCapabilityConfigRequest,
  WorkspaceCapabilityConfig
} from '../../shared/capabilities/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CapabilityRepository } from './capability-repository'
import { AGENT_CAPABILITIES, isKnownCapability, isLegalMode } from './capability-registry'
import { CapabilityWorkspaceNotFoundError, InvalidCapabilityConfigError, InvalidCapabilityRequestError } from './capability-errors'

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function defaultConfig(workspaceId: number): WorkspaceCapabilityConfig {
  return {
    workspaceId,
    enabled: false,
    policies: AGENT_CAPABILITIES.map((capability) => ({ capability, mode: 'deny' as const }))
  }
}

/**
 * Capability configuration service (Stage 22): validates and
 * atomically saves complete per-workspace policies, synthesizes
 * default-deny configs for never-configured workspaces. Zero provider
 * calls, zero filesystem, zero tool execution. Tables hold IDs and
 * modes only — no secrets, commands, paths, or output.
 */
export class CapabilityService {
  private readonly now: () => number

  constructor(
    private readonly store: CapabilityRepository,
    private readonly workspaces: WorkspaceRepository,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /** Complete config for one workspace; synthesized default-deny when absent. */
  getConfig(raw: unknown): WorkspaceCapabilityConfig {
    const workspaceId = this.parseWorkspaceScope(raw)
    this.requireWorkspace(workspaceId)
    const settings = this.store.findSettings(workspaceId)
    const rows = this.store.listPolicies(workspaceId)
    const byCapability = new Map<string, string>()
    for (const row of rows) {
      // Unknown stored capabilities are ignored (deny by construction);
      // known rows win. Stored modes are trusted as saved-validated.
      if (isKnownCapability(row.capability)) {
        byCapability.set(row.capability, row.mode)
      }
    }
    return {
      workspaceId,
      enabled: settings?.enabled ?? false,
      policies: AGENT_CAPABILITIES.map((capability) => ({
        capability,
        mode: (byCapability.get(capability) ?? 'deny') as CapabilityPolicyMode
      }))
    }
  }

  /** Validates and atomically saves a complete workspace configuration. */
  updateConfig(raw: unknown): WorkspaceCapabilityConfig {
    if (!hasStrictShape(raw, ['workspaceId', 'enabled', 'policies'])) {
      throw new InvalidCapabilityRequestError('capability configuration is invalid')
    }
    const record = raw as Record<string, unknown>
    const { workspaceId, enabled, policies } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidCapabilityRequestError('workspace reference is invalid')
    }
    if (typeof enabled !== 'boolean') {
      throw new InvalidCapabilityRequestError('capability configuration is invalid')
    }
    if (!Array.isArray(policies)) {
      throw new InvalidCapabilityRequestError('capability configuration is invalid')
    }
    this.requireWorkspace(workspaceId)
    if (policies.length !== AGENT_CAPABILITIES.length) {
      throw new InvalidCapabilityConfigError()
    }
    const seen = new Set<string>()
    const normalized: { capability: AgentCapability; mode: CapabilityPolicyMode }[] = []
    for (const entry of policies) {
      if (!hasStrictShape(entry, ['capability', 'mode'])) {
        throw new InvalidCapabilityRequestError('capability configuration is invalid')
      }
      const item = entry as Record<string, unknown>
      const capability = item['capability']
      const mode = item['mode']
      if (typeof capability !== 'string' || !isKnownCapability(capability)) {
        throw new InvalidCapabilityConfigError()
      }
      if (typeof mode !== 'string' || !isLegalMode(capability, mode)) {
        throw new InvalidCapabilityConfigError()
      }
      if (seen.has(capability)) {
        throw new InvalidCapabilityConfigError()
      }
      seen.add(capability)
      normalized.push({ capability, mode })
    }
    for (const capability of AGENT_CAPABILITIES) {
      if (!seen.has(capability)) {
        throw new InvalidCapabilityConfigError()
      }
    }
    // Deterministic storage order: registry order.
    const ordered = AGENT_CAPABILITIES.map(
      (capability) => normalized.find((entry) => entry.capability === capability) as { capability: AgentCapability; mode: CapabilityPolicyMode }
    )
    this.store.saveConfig({
      workspaceId,
      enabled,
      policies: ordered.map((entry) => ({ capability: entry.capability, mode: entry.mode })),
      now: this.now()
    })
    return {
      workspaceId,
      enabled,
      policies: ordered.map((entry) => ({ capability: entry.capability, mode: entry.mode }))
    }
  }

  /** Synthesized default-deny config without touching storage (tests/docs). */
  defaultFor(workspaceId: number): WorkspaceCapabilityConfig {
    return defaultConfig(workspaceId)
  }

  private parseWorkspaceScope(raw: unknown): number {
    if (!hasStrictShape(raw, ['workspaceId'])) {
      throw new InvalidCapabilityRequestError('capability request is invalid')
    }
    const workspaceId = (raw as Record<string, unknown>)['workspaceId']
    if (!isValidId(workspaceId)) {
      throw new InvalidCapabilityRequestError('workspace reference is invalid')
    }
    return workspaceId
  }

  private requireWorkspace(workspaceId: number): void {
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new CapabilityWorkspaceNotFoundError()
    }
  }
}

/** Validates an update payload shape for IPC use (service re-validates). */
export function validateCapabilityUpdateRequest(raw: unknown): UpdateWorkspaceCapabilityConfigRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidCapabilityRequestError('capability configuration is invalid')
  }
  return raw as UpdateWorkspaceCapabilityConfigRequest
}
