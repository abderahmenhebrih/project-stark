import {
  DEFAULT_AGENT_TARGET,
  DEFAULT_STARK_EFFORT,
  KILO_ADAPTER_ID,
  STARK_EFFORTS,
  isStarkEffort,
  normalizeStarkEffort,
  resolveStarkSendMode,
  type AgentTarget,
  type KiloAvailability,
  type StarkEffort,
  type StarkSendMode
} from '../../../../shared/agent-target/types'

/**
 * Pure composer target + effort state (no React imports) so agent
 * selection, slash overrides, unified send, draft survival, and
 * in-flight guards are unit-testable with the Node runner.
 *
 * - Default target STARK; Kilo selectable only when available.
 * - Normal STARK send uses the unified Work path; /ask /work
 *   /propose are explicit internal overrides (runtime paths kept).
 * - Effort/target persist per session inside the existing tab-draft
 *   stash (renderer memory only — never web storage, never the DB,
 *   so schema stays v19 with no migration).
 * - Switching target during an active run is blocked (caller checks
 *   isTargetSwitchBlocked); drafts always survive switches.
 */

export { STARK_EFFORTS, DEFAULT_STARK_EFFORT, DEFAULT_AGENT_TARGET, KILO_ADAPTER_ID, normalizeStarkEffort, resolveStarkSendMode }
export type { AgentTarget, StarkEffort, StarkSendMode, KiloAvailability }

export interface AgentTargetState {
  readonly target: AgentTarget
  readonly effort: StarkEffort
  readonly kilo: KiloAvailability
}

export function initialAgentTargetState(kilo?: KiloAvailability): AgentTargetState {
  return {
    target: { ...DEFAULT_AGENT_TARGET },
    effort: DEFAULT_STARK_EFFORT,
    kilo: kilo ?? { status: 'unavailable', reason: 'Kilo bridge not available', version: null }
  }
}

/** True when Kilo may be selected as a working target right now. */
export function canSelectKilo(kilo: KiloAvailability): boolean {
  return kilo.status === 'available' || kilo.status === 'running'
}

/** Selects a target; unavailable Kilo is refused (state unchanged). */
export function selectAgentTarget(state: AgentTargetState, target: AgentTarget): AgentTargetState {
  if (target.kind === 'external' && !canSelectKilo(state.kilo)) {
    return state
  }
  if (target.kind === state.target.kind) {
    if (target.kind === 'external' && state.target.kind === 'external' && target.adapterId !== state.target.adapterId) {
      return { ...state, target }
    }
    return state
  }
  return { ...state, target }
}

/** Sets effort (STARK only; external targets ignore it). */
export function setStarkEffort(state: AgentTargetState, effort: StarkEffort): AgentTargetState {
  if (!isStarkEffort(effort) || state.effort === effort) {
    return state
  }
  return { ...state, effort }
}

/**
 * True when a target switch must be blocked or deferred: a send,
 * generation, proposal, or work run is in flight. Callers keep the
 * draft and surface calm copy; the switch never drops unsent work.
 */
export function isTargetSwitchBlocked(flags: {
  readonly sending: boolean
  readonly generating: boolean
  readonly proposalPreparing: boolean
  readonly workPreparing: boolean
  readonly kiloRunning: boolean
}): boolean {
  return flags.sending || flags.generating || flags.proposalPreparing || flags.workPreparing || flags.kiloRunning
}

/** Effort applies only to STARK; external targets show "Managed by Kilo". */
export function effortVisibleFor(target: AgentTarget): boolean {
  return target.kind === 'stark'
}

/** Resolves the send mode for a STARK composer submission. */
export function resolveComposerSend(
  target: AgentTarget,
  composerText: string
): { readonly mode: StarkSendMode; readonly content: string } | { readonly blocked: 'external-unavailable' } {
  if (target.kind === 'external') {
    return { blocked: 'external-unavailable' }
  }
  return resolveStarkSendMode(composerText)
}
