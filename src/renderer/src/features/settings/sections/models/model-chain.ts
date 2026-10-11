/**
 * Brain/Heart LoopLink chain rules (Settings → Models V2).
 *
 * Pure, renderer-local, no React imports — unit-testable with the Node
 * runner. The single source of truth is the ORDERED ENABLED ID LIST
 * (see model-chains-state.ts). Roster rows are DERIVED from the
 * eligible plan catalog plus those active ids — never a second
 * boolean store (enabled = active chain contains the id).
 *
 * LOCKED rules (Free defaults; paid tiers raise the cap through the
 * central entitlements — see billing/entitlements.ts):
 * - Active holds 0..max entries (below cap allowed, empty allowed —
 *   the roster never disappears).
 * - The same model may NOT appear twice in one active chain.
 * - The same model MAY be active in both chains (lists independent).
 * - Disable collapses positions (no holes); re-enable appends to the
 *   END unless it arrives via the limit-swap flow (takes the replaced
 *   position); reorder preserves ids.
 * - Enabling past the cap is refused with `limitReached` (the UI
 *   opens the limit dialog — never silent, never auto-disabling).
 */
import type { StarkModelIdentity } from './model-library'
import { canEnterChain } from './model-library'

/** Free-tier chain cap. Paid entitlements pass a higher max explicitly. */
export const MAX_CHAIN_MODELS = 5

export const MIN_CHAIN_MODELS = 1

export type ModelChainKind = 'brain' | 'heart'

export type ChainMoveDirection = 'up' | 'down'

/** True when the chain already holds this model (same-chain duplicate). */
export function chainContains(chain: readonly string[], stableId: string): boolean {
  return chain.includes(stableId)
}

export interface ChainAddOutcome {
  readonly applied: boolean
  readonly chain: readonly string[]
  readonly reason: 'added' | 'duplicate-in-chain' | 'chain-full' | 'empty-id'
}

/**
 * Attempts to append one model to a chain. Rejects same-chain
 * duplicates and insertions past the entitlement cap (Free default 5;
 * paid tiers pass their max explicitly). Never reorders, never replaces.
 */
export function addToChain(
  chain: readonly string[],
  stableId: string,
  maxModels: number = MAX_CHAIN_MODELS
): ChainAddOutcome {
  if (stableId === '') {
    return { applied: false, chain, reason: 'empty-id' }
  }
  if (chain.includes(stableId)) {
    return { applied: false, chain, reason: 'duplicate-in-chain' }
  }
  if (chain.length >= maxModels) {
    return { applied: false, chain, reason: 'chain-full' }
  }
  return { applied: true, chain: [...chain, stableId], reason: 'added' }
}

/**
 * Removes one model from a chain. Positions collapse: removing #3 from
 * 1→2→3→4 yields 1→2→3 (former #4). Unknown ids leave the chain
 * untouched.
 */
export function removeFromChain(chain: readonly string[], stableId: string): readonly string[] {
  if (!chain.includes(stableId)) {
    return chain
  }
  return chain.filter((entry) => entry !== stableId)
}

/**
 * Moves one entry one step up/down the vertical list. Edge moves and
 * unknown ids are no-ops. Identities are preserved — only positions
 * change.
 */
export function moveInChain(
  chain: readonly string[],
  stableId: string,
  direction: ChainMoveDirection
): readonly string[] {
  const at = chain.indexOf(stableId)
  if (at === -1) {
    return chain
  }
  const next = direction === 'up' ? at - 1 : at + 1
  if (next < 0 || next >= chain.length) {
    return chain
  }
  const out = [...chain]
  const target = out[next]
  if (target === undefined) {
    return chain
  }
  out[next] = stableId
  out[at] = target
  return out
}

/** True when no further insertion is allowed (at the entitlement cap). */
export function isChainFull(chain: readonly string[], maxModels: number = MAX_CHAIN_MODELS): boolean {
  return chain.length >= maxModels
}

/**
 * Availability of one chain entry against the current library.
 * Missing ids (key removed, discovery shrunk) report unavailable so
 * configuration is never silently lost. Callers render Unavailable and
 * keep the position; runtime enforcement belongs to the later AI
 * integration pass.
 */
export function isChainEntryAvailable(libraryIds: ReadonlySet<string>, stableId: string): boolean {
  return libraryIds.has(stableId)
}

/** One derived LoopLink roster row. `enabled` is derived, never stored. */
export interface LoopLinkRosterRow {
  readonly stableId: string
  readonly enabled: boolean
  /** 1-based position within the active chain, or null when disabled. */
  readonly position: number | null
  /** Catalog entry when resolvable; undefined for retained stale ids. */
  readonly entry: StarkModelIdentity | undefined
}

export interface LoopLinkRoster {
  readonly rows: readonly LoopLinkRosterRow[]
  readonly enabledCount: number
  readonly totalCount: number
}

/**
 * Derives the full plan roster: enabled rows first in active order
 * (including retained ids missing from the catalog, marked
 * entry-less), then disabled rows in catalog order. Eligible = usable
 * now (locked/unavailable plan entries excluded); the roster grows
 * automatically when Billing adds paid catalog entries later.
 */
export function deriveModelRoster(
  library: readonly StarkModelIdentity[],
  activeIds: readonly string[]
): LoopLinkRoster {
  const byId = new Map(library.map((entry) => [entry.stableId, entry]))
  const activeSet = new Set(activeIds)
  const rows: LoopLinkRosterRow[] = []
  activeIds.forEach((stableId, index) => {
    rows.push({ stableId, enabled: true, position: index + 1, entry: byId.get(stableId) })
  })
  for (const entry of library) {
    if (activeSet.has(entry.stableId) || !canEnterChain(entry)) {
      continue
    }
    rows.push({ stableId: entry.stableId, enabled: false, position: null, entry })
  }
  const enabledCount = activeIds.length
  return { rows, enabledCount, totalCount: rows.length }
}

export interface EnableModelOutcome {
  readonly applied: boolean
  /** True when the entitlement cap blocked the enable (open the limit dialog). */
  readonly limitReached: boolean
  readonly chain: readonly string[]
}

/**
 * Enables one model (append to END of active order) unless already
 * active or the cap is reached. Never auto-disables another model.
 */
export function enableModel(
  active: readonly string[],
  stableId: string,
  maxModels: number = MAX_CHAIN_MODELS
): EnableModelOutcome {
  if (stableId === '' || active.includes(stableId)) {
    return { applied: false, limitReached: false, chain: active }
  }
  if (active.length >= maxModels) {
    return { applied: false, limitReached: true, chain: active }
  }
  return { applied: true, limitReached: false, chain: [...active, stableId] }
}

export interface DisableModelOutcome {
  readonly applied: boolean
  readonly chain: readonly string[]
}

/** Disables one model (positions collapse, row stays visible). */
export function disableModel(active: readonly string[], stableId: string): DisableModelOutcome {
  if (!active.includes(stableId)) {
    return { applied: false, chain: active }
  }
  return { applied: true, chain: active.filter((entry) => entry !== stableId) }
}

export interface SwapModelOutcome {
  readonly applied: boolean
  readonly chain: readonly string[]
}

/**
 * Limit-flow swap: the incoming model takes the SAME active position
 * as the replaced outgoing model. Count is preserved; duplicates
 * impossible (incoming already active, or outgoing missing, rejects).
 */
export function swapEnabledModel(
  active: readonly string[],
  outgoingId: string,
  incomingId: string
): SwapModelOutcome {
  const at = active.indexOf(outgoingId)
  if (at === -1 || incomingId === '' || (incomingId !== outgoingId && active.includes(incomingId))) {
    return { applied: false, chain: active }
  }
  const next = [...active]
  next[at] = incomingId
  return { applied: true, chain: next }
}

/**
 * Drag/keyboard reorder inside the enabled region: moves one active id
 * to a target index (clamped). Order-only — nothing enables/disables.
 */
export function reorderEnabledModel(
  active: readonly string[],
  stableId: string,
  toIndex: number
): readonly string[] {
  const from = active.indexOf(stableId)
  if (from === -1) {
    return active
  }
  const clamped = Math.max(0, Math.min(active.length - 1, toIndex))
  if (clamped === from) {
    return active
  }
  const next = active.filter((entry) => entry !== stableId)
  next.splice(clamped, 0, stableId)
  return next
}
