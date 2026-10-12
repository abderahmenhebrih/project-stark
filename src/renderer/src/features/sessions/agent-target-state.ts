import type { ExtensionAgentProviderInfo } from '../../../../shared/extension-agents/types'
import {
  DEFAULT_AGENT_TARGET,
  DEFAULT_STARK_EFFORT,
  STARK_EFFORTS,
  isStarkEffort,
  normalizeStarkEffort,
  resolveStarkSendMode,
  type AgentTarget,
  type StarkEffort,
  type StarkSendMode
} from '../../../../shared/agent-target/types'

/**
 * Pure composer target + effort state (no React imports) so agent
 * selection, slash overrides, unified send, draft survival, and
 * in-flight guards are unit-testable with the Node runner.
 *
 * - Default target STARK; extension targets are data-driven provider
 *   rows (never vendor unions) selectable only when available.
 * - Normal STARK send uses the unified Work path; /ask /work
 *   /propose are explicit internal overrides (runtime paths kept).
 * - Effort/target persist per session inside the existing tab-draft
 *   stash (renderer memory only — never web storage, never the DB,
 *   so schema stays v19 with no migration).
 * - STARK effort never applies to extension targets (hidden there;
 *   never sent to extensions).
 * - Switching target during an active run is blocked (caller checks
 *   isTargetSwitchBlocked); drafts always survive switches.
 */

export { STARK_EFFORTS, DEFAULT_STARK_EFFORT, DEFAULT_AGENT_TARGET, normalizeStarkEffort, resolveStarkSendMode }
export type { AgentTarget, StarkEffort, StarkSendMode, ExtensionAgentProviderInfo }

export interface AgentTargetState {
  readonly target: AgentTarget
  readonly effort: StarkEffort
  readonly providers: readonly ExtensionAgentProviderInfo[]
}

export function initialAgentTargetState(
  providers: readonly ExtensionAgentProviderInfo[] = []
): AgentTargetState {
  return {
    target: { ...DEFAULT_AGENT_TARGET },
    effort: DEFAULT_STARK_EFFORT,
    providers: [...providers]
  }
}

/** True when a provider row may be selected as a working target right now. */
export function canSelectProvider(provider: ExtensionAgentProviderInfo): boolean {
  return provider.availability.status === 'available' || provider.availability.status === 'running'
}

/** Finds a provider row by exact data coordinates (no name matching). */
export function findProvider(
  providers: readonly ExtensionAgentProviderInfo[],
  extensionId: string,
  providerId: string
): ExtensionAgentProviderInfo | undefined {
  return providers.find((entry) => entry.extensionId === extensionId && entry.providerId === providerId)
}

/** Selects a target; unavailable providers are refused (state unchanged). */
export function selectAgentTarget(state: AgentTargetState, target: AgentTarget): AgentTargetState {
  if (target.kind === 'extension') {
    const provider = findProvider(state.providers, target.extensionId, target.providerId)
    if (provider === undefined || !canSelectProvider(provider)) {
      return state
    }
  }
  if (
    target.kind === state.target.kind &&
    (target.kind === 'stark' ||
      (state.target.kind === 'extension' &&
        target.extensionId === state.target.extensionId &&
        target.providerId === state.target.providerId))
  ) {
    return state
  }
  return { ...state, target }
}

/** Sets effort (STARK only; extension targets ignore it). */
export function setStarkEffort(state: AgentTargetState, effort: StarkEffort): AgentTargetState {
  if (!isStarkEffort(effort) || state.effort === effort) {
    return state
  }
  return { ...state, effort }
}

/**
 * True when a target switch must be blocked or deferred: a send,
 * generation, proposal, work, or agent run is in flight. Callers keep
 * the draft and surface calm copy; the switch never drops unsent work.
 */
export function isTargetSwitchBlocked(flags: {
  readonly sending: boolean
  readonly generating: boolean
  readonly proposalPreparing: boolean
  readonly workPreparing: boolean
  readonly agentRunning: boolean
}): boolean {
  return flags.sending || flags.generating || flags.proposalPreparing || flags.workPreparing || flags.agentRunning
}

/** Effort applies only to STARK; extension agents own their own behavior. */
export function effortVisibleFor(target: AgentTarget): boolean {
  return target.kind === 'stark'
}

/** Display label for the Usage Status agent row (STARK or the provider's own name). */
export function agentTargetLabel(target: AgentTarget, providers: readonly ExtensionAgentProviderInfo[]): string {
  if (target.kind === 'stark') {
    return 'STARK'
  }
  return findProvider(providers, target.extensionId, target.providerId)?.displayName ?? 'Extension agent'
}

/**
 * Resolves one composer submission: STARK targets resolve to the
 * unified runtime mode (slash overrides win); extension targets
 * resolve to a provider run with the raw text (slashes are
 * STARK-internal and are never interpreted for extensions).
 */
export function resolveComposerSend(
  target: AgentTarget,
  composerText: string,
  providers: readonly ExtensionAgentProviderInfo[] = []
):
  | { readonly kind: 'stark'; readonly mode: StarkSendMode; readonly content: string }
  | { readonly kind: 'extension'; readonly extensionId: string; readonly providerId: string }
  | { readonly kind: 'blocked'; readonly reason: string } {
  if (target.kind === 'stark') {
    const resolved = resolveStarkSendMode(composerText)
    return { kind: 'stark', mode: resolved.mode, content: resolved.content }
  }
  const provider = findProvider(providers, target.extensionId, target.providerId)
  if (provider === undefined || !canSelectProvider(provider)) {
    return { kind: 'blocked', reason: provider?.availability.reason ?? 'That extension agent is not available.' }
  }
  return { kind: 'extension', extensionId: target.extensionId, providerId: target.providerId }
}
