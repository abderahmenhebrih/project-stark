/**
 * Brain/Heart LoopLink chain rules (Settings → Models V2).
 *
 * Pure, renderer-local, no React imports — unit-testable with the Node
 * runner. Chains are ordered lists of stable model ids (see
 * model-library.ts). No secrets, no provider config, no inference.
 *
 * LOCKED rules (Free defaults; paid tiers raise the cap through the
 * central entitlements — see billing/entitlements.ts):
 * - 1..max entries when configured (fewer allowed, never 0 via
 *   add-path; empty renders as configuration-required).
 * - The same model may NOT appear twice inside one chain.
 * - The same model MAY appear in both chains (enforced by keeping the
 *   two lists independent — no cross-chain check lives here).
 * - Removal collapses positions (no holes); reorder preserves ids.
 * - Insertions past the cap are rejected by state logic, not CSS.
 */

/** Free-tier chain cap. Paid entitlements pass a higher max explicitly. */
export const MAX_CHAIN_MODELS = 5

export const MIN_CHAIN_MODELS = 1

export type ModelChainKind = 'brain' | 'heart'

export type ChainMoveDirection = 'left' | 'right'

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
 * Moves one entry one step left/right. Edge moves and unknown ids are
 * no-ops. Identities are preserved — only positions change.
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
  const next = direction === 'left' ? at - 1 : at + 1
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
