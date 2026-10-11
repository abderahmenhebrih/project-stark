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
 * - built-in: the STARK Free catalog (exactly 15 locked entries, see
 *   FREE_MODEL_DEFINITIONS). Appears automatically, needs no API
 *   setup, is never deletable, and may enter either chain. Here
 *   "built-in" means built into the catalog/configuration — no
 *   weight files are bundled by this pass.
 * - api / local: user-added through Add API key / Link a local model.
 *   Only api exists today (single configured provider); local is the
 *   reserved shape for the future linking runtime.
 * - plan: reserved for the future Billing build. Lock derives from
 *   entitlements, never from identity, so a future unlock flips
 *   availability without replacing the entry. No paid catalog exists
 *   yet, so nothing with this origin is rendered.
 *
 * CATALOG AVAILABILITY vs INFERENCE RUNTIME: `available` below means
 * "selectable in Brain/Heart configuration". It does NOT mean a
 * proven remote inference endpoint exists — execution runtime for
 * these entries is a later AI-integration dependency, and the page
 * states plainly that chains do not route yet.
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
  /** Small card badge: FREE, API, Local, else null. */
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

/**
 * STARK Free catalog (product-locked, exactly 15 entries, fixed order).
 * Present after installation, no setup. Stable ids live under the
 * `builtin:` namespace via stableModelId; providerId carries the
 * family identity for presentation only (catalog identity, NOT
 * inference routing — no backends are implemented by this pass).
 */
const BUILT_IN_DEFINITIONS: readonly CatalogDefinition[] = [
  { providerId: 'meta', providerLabel: 'Meta', model: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', sourceType: 'remote' },
  { providerId: 'zai', providerLabel: 'Z.ai', model: 'glm-5.3-flash', displayName: 'GLM-5.3 Flash', sourceType: 'remote' },
  { providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', sourceType: 'remote' },
  { providerId: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.6-luna', displayName: 'GPT 5.6 Luna', sourceType: 'remote' },
  { providerId: 'google', providerLabel: 'Google', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', sourceType: 'remote' },
  { providerId: 'anthropic', providerLabel: 'Anthropic', model: 'claude-haiku-5.5', displayName: 'Claude Haiku 5.5', sourceType: 'remote' },
  { providerId: 'minimax', providerLabel: 'MiniMax', model: 'minimax-m3', displayName: 'MiniMax M3', sourceType: 'remote' },
  { providerId: 'moonshot', providerLabel: 'Moonshot', model: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', sourceType: 'remote' },
  { providerId: 'xiaomi', providerLabel: 'Xiaomi', model: 'mimo-v2.6-pro', displayName: 'MiMo-V2.6-Pro', sourceType: 'remote' },
  { providerId: 'xiaomi', providerLabel: 'Xiaomi', model: 'mimo-v2.6-flash', displayName: 'MiMo-V2.6-Flash', sourceType: 'remote' },
  { providerId: 'nvidia', providerLabel: 'NVIDIA', model: 'nemotron-3.5-lightning', displayName: 'Nemotron 3.5 Lightning', sourceType: 'remote' },
  { providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', sourceType: 'remote' },
  { providerId: 'meta', providerLabel: 'Meta', model: 'muse-spark-1.2', displayName: 'Muse Spark 1.2', sourceType: 'remote' },
  { providerId: 'longcat', providerLabel: 'LongCat', model: 'longcat-2.0', displayName: 'LongCat 2.0', sourceType: 'remote' },
  { providerId: 'mistral', providerLabel: 'Mistral AI', model: 'mistral-large-4', displayName: 'Mistral Large 4', sourceType: 'remote' }
]

/** Product-locked Free catalog size. Exactly 15 — never 14, 16, or 15 + placeholder. */
export const FREE_CATALOG_COUNT = 15

interface PlanDefinition extends CatalogDefinition {
  readonly planRequirement: string
}

/**
 * Paid catalog (Magma/Frost/Void): intentionally empty until Billing
 * defines the real entries. The plan origin, entitlement seam, lock
 * derivation, and locked-card upgrade route are preserved below so
 * Billing can introduce paid models without rewriting the catalog.
 */
const PLAN_DEFINITIONS: readonly PlanDefinition[] = []

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
 * Derives the usable Model Library in predictable order: the 15
 * STARK Free built-ins (fixed product order, never sorted), then
 * user-added (sorted), then plan-exclusive (empty until Billing
 * defines the paid catalog). The Add model card renders last at the
 * call site.
 *
 * - Built-in entries appear without any setup.
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
      stableId: stableModelId('builtin', definition.model),
      providerId: definition.providerId,
      providerLabel: definition.providerLabel,
      model: definition.model,
      displayName: definition.displayName,
      sourceType: definition.sourceType,
      origin: 'built-in',
      available: true,
      locked: false,
      badge: 'FREE',
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
