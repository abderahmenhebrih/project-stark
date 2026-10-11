import type { ProviderPanelState } from '../../../sessions/provider-state'

/**
 * Model Library catalog (Settings → Models V2).
 *
 * ONE representation for every card: stable id, display name,
 * origin, transport, honest token metadata, availability, and plan
 * requirement. Chain entries reference `stableId` only — catalog
 * entries never carry credential material of any form.
 *
 * THREE origins (locked product model):
 * - built-in: STARK's included catalog. Appears automatically, needs
 *   no API setup, is never deletable, and may enter either chain.
 *   Here "built-in" means built into the catalog/configuration — no
 *   weight files are bundled by this pass. Execution runtime for
 *   these entries is a later AI-integration dependency; the page
 *   states plainly that chains do not route yet.
 * - api / local: user-added through Add API key / Link a local model.
 *   Only api exists today (single configured provider); local is the
 *   reserved shape for the future linking runtime.
 * - plan: visible while locked, never insertable until entitled.
 *   Locked-ness derives from entitlements, never from identity, so a
 *   future unlock flips availability without replacing the entry.
 */

export type ModelOrigin = 'built-in' | 'api' | 'local' | 'plan'

export type ModelSourceType = 'remote' | 'local'

export interface StarkModelIdentity {
  readonly stableId: string
  readonly providerId: string
  readonly providerLabel: string
  readonly model: string
  readonly displayName: string
  readonly sourceType: ModelSourceType
  readonly origin: ModelOrigin
  /** Chain-selectable now. False renders as Unavailable, never destroyed. */
  readonly available: boolean
  /** Plan entry without entitlement. Never insertable while locked. */
  readonly locked: boolean
  /** Small card badge: Included, API, Local, Pro, else null. */
  readonly badge: string | null
  /** Plan requirement copy for plan entries, else null. */
  readonly planRequirement: string | null
}

/**
 * Narrow entitlement seam for the future Billing build. Callers pass
 * real entitlements when they exist; this pass always passes none, so
 * plan entries stay locked. No fake entitlements are constructed here.
 */
export interface ModelEntitlements {
  readonly planModels: readonly string[]
}

export const NO_ENTITLEMENTS: ModelEntitlements = { planModels: [] }

/** Stable identity for one model. Format `providerId:model`. */
export function stableModelId(providerId: string, model: string): string {
  return `${providerId}:${model}`
}

/**
 * Honest token/session metadata.
 *
 * The architecture defines no per-model tokens-per-session value:
 * ProviderModel is ID-only and AI limits are global output/context
 * budgets shared by every model. Deriving a per-card number from the
 * global output budget would misrepresent it as a model capability,
 * so every card reports unavailable. Documented here as the single
 * derivation point for the card copy.
 */
export function tokenSessionLabel(): string {
  return 'Token limit unavailable'
}

interface CatalogDefinition {
  readonly providerId: string
  readonly providerLabel: string
  readonly model: string
  readonly displayName: string
  readonly sourceType: ModelSourceType
}

/** STARK's included catalog: present after installation, no setup. */
const BUILT_IN_DEFINITIONS: readonly CatalogDefinition[] = [
  { providerId: 'stark', providerLabel: 'STARK', model: 'built-in', displayName: 'STARK Built-in', sourceType: 'remote' }
]

interface PlanDefinition extends CatalogDefinition {
  readonly planRequirement: string
}

/** Plan-exclusive catalog: visible while locked, no backend yet. */
const PLAN_DEFINITIONS: readonly PlanDefinition[] = [
  {
    providerId: 'stark',
    providerLabel: 'STARK',
    model: 'pro',
    displayName: 'STARK Pro',
    sourceType: 'remote',
    planRequirement: 'STARK plan'
  }
]

/** True when entitlements unlock one plan entry. */
export function isPlanEntitled(stableId: string, entitlements: ModelEntitlements): boolean {
  return entitlements.planModels.includes(stableId)
}

/**
 * Whether an entry may be used now: plan entries need entitlement,
 * everything else needs availability.
 */
export function canUseModel(entry: StarkModelIdentity, entitlements: ModelEntitlements = NO_ENTITLEMENTS): boolean {
  if (entry.origin === 'plan' && !isPlanEntitled(entry.stableId, entitlements)) {
    return false
  }
  return entry.available
}

/**
 * Configuration-time guard for Brain/Heart insertion. Locked plan
 * entries are refused here — never inserted hoping runtime rejects
 * them later. Unavailable entries are refused for new insertions;
 * entries already in a chain keep their position as Unavailable.
 */
export function canEnterChain(entry: StarkModelIdentity, entitlements: ModelEntitlements = NO_ENTITLEMENTS): boolean {
  return canUseModel(entry, entitlements)
}

/**
 * Derives the usable Model Library in predictable order: built-in,
 * then user-added (sorted), then plan-exclusive. The Add model card
 * renders last at the call site.
 *
 * - Built-in and locked plan entries appear without any setup.
 * - User entries appear only while their provider is configured
 *   (discovery plus the persisted selected model, deduped).
 * - Lock derives from entitlements so a future unlock keeps identity.
 */
export function deriveModelLibrary(
  provider: ProviderPanelState,
  entitlements: ModelEntitlements = NO_ENTITLEMENTS
): readonly StarkModelIdentity[] {
  const out: StarkModelIdentity[] = []
  for (const definition of BUILT_IN_DEFINITIONS) {
    out.push({
      stableId: stableModelId(definition.providerId, definition.model),
      providerId: definition.providerId,
      providerLabel: definition.providerLabel,
      model: definition.model,
      displayName: definition.displayName,
      sourceType: definition.sourceType,
      origin: 'built-in',
      available: true,
      locked: false,
      badge: 'Included',
      planRequirement: null
    })
  }
  if (provider.configured) {
    const seen = new Set<string>()
    const user: StarkModelIdentity[] = []
    const push = (model: string): void => {
      if (model === '' || seen.has(model)) {
        return
      }
      seen.add(model)
      user.push({
        stableId: stableModelId('openai', model),
        providerId: 'openai',
        providerLabel: provider.displayName,
        model,
        displayName: model,
        sourceType: 'remote',
        origin: 'api',
        available: true,
        locked: false,
        badge: 'API',
        planRequirement: null
      })
    }
    for (const entry of provider.models) {
      push(entry.id)
    }
    if (provider.selectedModel !== null) {
      push(provider.selectedModel)
    }
    user.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    out.push(...user)
  }
  for (const definition of PLAN_DEFINITIONS) {
    const stableId = stableModelId(definition.providerId, definition.model)
    const entitled = isPlanEntitled(stableId, entitlements)
    out.push({
      stableId,
      providerId: definition.providerId,
      providerLabel: definition.providerLabel,
      model: definition.model,
      displayName: definition.displayName,
      sourceType: definition.sourceType,
      origin: 'plan',
      available: entitled,
      locked: !entitled,
      badge: 'Pro',
      planRequirement: definition.planRequirement
    })
  }
  return out
}

/** Finds one library identity by stable id. Undefined when absent. */
export function findLibraryModel(
  library: readonly StarkModelIdentity[],
  stableId: string
): StarkModelIdentity | undefined {
  return library.find((entry) => entry.stableId === stableId)
}
