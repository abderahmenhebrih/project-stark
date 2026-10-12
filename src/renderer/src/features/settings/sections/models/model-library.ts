import type { ProviderPanelState } from '../../../sessions/provider-state'
import { isCompatibleModelId } from './model-compatibility'

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
 *   FREE_MODEL_DEFINITIONS). Intrinsic STARK state: appears
 *   automatically, needs no API setup, is never deletable, and is
 *   selectable for Brain/Heart configuration with zero user provider
 *   setup. Here "built-in" means built into the catalog/configuration
 *   — no weight files are bundled by this pass.
 * - api / local: user-added through Add API key / Link a local model.
 *   Only api exists today (single configured provider); local is the
 *   reserved shape for the future linking runtime.
 * - plan: reserved for the future Billing build. Lock derives from
 *   entitlements, never from identity, so a future unlock flips
 *   availability without replacing the entry. No paid catalog exists
 *   yet, so nothing with this origin is rendered.
 *
 * CATALOG AVAILABILITY vs INFERENCE RUNTIME: `available` below means
 * "selectable now" — present in the library, runnable-selectable,
 * and chain-enterable. The 15 Free built-ins are intrinsic STARK
 * state: always available with zero user provider setup. Optional
 * user-connected (BYOK) entries appear only while their provider is
 * configured, filtered to models compatible with STARK's inference
 * call shape (see model-compatibility.ts).
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
  /** Selectable now. False renders as Unavailable, never destroyed. */
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
 * family identity for presentation (catalog identity).
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

/**
 * Default STARK Free Brain Chain (product configuration, fixed order):
 * planning-first orchestration defaults. Entries are catalog `model`
 * slugs — stable ids derive via `stableModelId('builtin', …)` so the
 * catalog stays the single source of truth. Unknown slugs (catalog
 * drift) are dropped, never phantom-inserted; order is preserved and
 * the result never exceeds the Free cap of 5.
 */
const DEFAULT_FREE_BRAIN_MODELS: readonly string[] = [
  'gpt-5.6-luna',
  'deepseek-v4.1-flash',
  'gemini-2.5-flash',
  'claude-haiku-5.5',
  'glm-5.3-flash'
]

/**
 * Default STARK Free Heart Chain (product configuration, fixed order):
 * execution/code-first defaults. Same derivation and safety rules as
 * the Brain defaults. Cross-chain duplicates (GPT 5.6 Luna, DeepSeek
 * V4.1 Flash) are intentional and allowed — only same-chain
 * duplicates are forbidden (see model-chain.ts).
 */
const DEFAULT_FREE_HEART_MODELS: readonly string[] = [
  'kimi-k2.7-code',
  'gpt-5.6-luna',
  'deepseek-v4.1-flash',
  'mimo-v2.6-pro',
  'muse-spark-1.3'
]

/** Known catalog slugs under the `builtin:` namespace (validation set for defaults). */
function freeBuiltinModels(): ReadonlySet<string> {
  return new Set(BUILT_IN_DEFINITIONS.map((definition) => stableModelId('builtin', definition.model)))
}

/**
 * Builds one validated default chain: catalog-membership checked,
 * order-preserving, de-duplicated, capped at 5. Never invents ids —
 * a slug missing from the locked catalog is dropped.
 */
function buildDefaultChain(models: readonly string[]): readonly string[] {
  const known = freeBuiltinModels()
  const out: string[] = []
  for (const model of models) {
    const stableId = stableModelId('builtin', model)
    if (!known.has(stableId) || out.includes(stableId)) {
      continue
    }
    out.push(stableId)
    if (out.length >= 5) {
      break
    }
  }
  return out
}

/**
 * Fresh-configuration Brain defaults: exactly the five ordered
 * planning-first Free models. Configuration/presentation only — chain
 * entries never imply inference routing (see the module header).
 */
export function createDefaultFreeBrainChain(): readonly string[] {
  return buildDefaultChain(DEFAULT_FREE_BRAIN_MODELS)
}

/**
 * Fresh-configuration Heart defaults: exactly the five ordered
 * execution-first Free models. Same non-routing caveat as Brain.
 */
export function createDefaultFreeHeartChain(): readonly string[] {
  return buildDefaultChain(DEFAULT_FREE_HEART_MODELS)
}

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
 * everything else needs availability. Free built-ins are always
 * available — zero provider setup required.
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
 * STARK Free built-ins (fixed product order, never sorted — always
 * present, no setup), then optional user-connected provider models
 * (sorted, compatible discovered entries only), then plan-exclusive
 * (empty until Billing defines the paid catalog). The Add model card
 * renders last at the call site.
 *
 * - Built-in entries appear without any setup.
 * - User entries appear only while their provider is configured:
 *   compatible discovered models (automatic — no manual entry),
 *   plus the persisted selected model as Unavailable when it is no
 *   longer in the compatible discovered set (disappeared or
 *   incompatible selections never route silently).
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
    const push = (model: string, runnable: boolean): void => {
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
        available: runnable,
        locked: false,
        badge: 'API',
        planRequirement: null
      })
    }
    // Automatic discovery: only compatible models become runnable
    // entries. Raw incompatible ids never enter the library.
    for (const entry of provider.models) {
      if (isCompatibleModelId('openai', entry.id)) {
        push(entry.id, true)
      }
    }
    // The persisted selection stays visible when it leaves the
    // compatible set (provider removed it, or it was never
    // compatible): rendered Unavailable, never runnable, so runs
    // cannot silently target a disappeared model.
    if (provider.selectedModel !== null && !seen.has(provider.selectedModel)) {
      push(provider.selectedModel, false)
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
