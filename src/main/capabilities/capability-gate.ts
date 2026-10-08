import type { AgentCapability } from '../../shared/capabilities/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { CapabilityRepository } from './capability-repository'
import { isKnownCapability } from './capability-registry'

/** Who requests the capability. Brain never has tool authority. */
export type CapabilityActor = 'brain' | 'worker'

/** Deterministic authorization decision. No arbitrary strings. */
export type CapabilityDecision =
  | {
      readonly decision: 'deny'
      readonly capability: AgentCapability
      readonly reason: 'workspace-disabled' | 'policy-deny' | 'brain-has-no-tool-authority' | 'unknown-capability'
    }
  | {
      readonly decision: 'requires_approval'
      readonly capability: AgentCapability
    }
  | {
      readonly decision: 'allow'
      readonly capability: AgentCapability
    }

export interface AuthorizeInput {
  readonly workspaceId: number
  readonly sessionId: number
  readonly actor: CapabilityActor
  readonly capability: string
}

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Main-internal capability gate (Stage 22): deterministic permission
 * check for FUTURE Worker tools. Local bounded DB lookup only — no
 * side effects, no provider calls, no filesystem, no tool execution.
 * Existing human workflows never consult this gate.
 */
export class CapabilityGate {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly store: CapabilityRepository
  ) {}

  authorize(input: AuthorizeInput): CapabilityDecision {
    const { workspaceId, sessionId, actor, capability } = input
    // Unknown capability strings deny (never throw through the gate).
    if (typeof capability !== 'string' || !isKnownCapability(capability)) {
      // Preserve a known capability shape for the typed result when
      // possible; unknown strings still deny safely.
      return {
        decision: 'deny',
        capability: 'workspace.read',
        reason: 'unknown-capability'
      }
    }
    // Workspace + session ownership first (cross-workspace never inherits).
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      return { decision: 'deny', capability, reason: 'policy-deny' }
    }
    if (this.workspaces.findById(workspaceId) === undefined) {
      return { decision: 'deny', capability, reason: 'policy-deny' }
    }
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined || session.workspaceId !== workspaceId) {
      return { decision: 'deny', capability, reason: 'policy-deny' }
    }
    // Brain is orchestration-only: never direct tool authority.
    if (actor === 'brain') {
      return { decision: 'deny', capability, reason: 'brain-has-no-tool-authority' }
    }
    if (actor !== 'worker') {
      return { decision: 'deny', capability, reason: 'policy-deny' }
    }
    // Master kill switch: absent or disabled denies everything while
    // preserving configured modes for later re-enable.
    const settings = this.store.findSettings(workspaceId)
    if (settings === undefined || settings.enabled !== true) {
      return { decision: 'deny', capability, reason: 'workspace-disabled' }
    }
    const rows = this.store.listPolicies(workspaceId)
    const mode = rows.find((row) => row.capability === capability)?.mode ?? 'deny'
    if (mode === 'allow') {
      return { decision: 'allow', capability }
    }
    if (mode === 'ask') {
      return { decision: 'requires_approval', capability }
    }
    return { decision: 'deny', capability, reason: 'policy-deny' }
  }
}
