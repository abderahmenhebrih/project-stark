/**
 * Discovered provider-model compatibility (Settings → Models).
 *
 * Pure, renderer-local, no React imports — unit-testable with the
 * Node runner. Classifies raw provider model-list ids against
 * STARK's current inference call shape: exactly one Responses-API
 * text call (`responses.create` with instructions + input, optional
 * reasoning effort, optional strict json_schema) through the single
 * registered `openai` route.
 *
 * Only models proven compatible with that call shape are runnable.
 * Exclusions are narrow and named: known non-text modalities (audio,
 * image, embeddings, moderation, realtime) and legacy completions
 * families that predate the Responses API. Everything else is treated
 * as a text chat candidate — a new flagship that follows the same
 * shape works without a client update. No claim is made about
 * tool/reasoning/streaming support: those fields are never asserted
 * here, and models that refuse structured output already surface the
 * mapped `ProviderStructuredOutputUnsupportedError` at runtime.
 *
 * Display names are never fabricated: displayName is always the
 * provider model id. Stable library ids derive deterministically as
 * `openai:<model-id>` (see model-library.ts).
 */

import { isCompatibleModelId } from '../../../../../../shared/hosted-models/openai-compatibility'
export type { DiscoveredProviderModel } from '../../../../../../shared/hosted-models/openai-compatibility'
export {
  classifyDiscoveredModel,
  compatibleModelIds,
  isCompatibleModelId
} from '../../../../../../shared/hosted-models/openai-compatibility'

/**
 * Explicit compatibility preference order for default selection.
 * Ranking only: every entry is a real OpenAI chat family, and only
 * ids actually present in the discovery result can win, so an unknown
 * or retired name simply never matches. Family variants rank with
 * their entry via separator-prefix match (`gpt-5-mini` with `gpt-5`,
 * `gpt-4o-2024-11-20` with `gpt-4o`). Specific families precede their
 * prefixes (`gpt-4o` before `gpt-4`) and exact ids beat family
 * variants within one entry (see chooseDefaultModel).
 */
export const MODEL_PREFERENCE_ORDER: readonly string[] = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'o4-mini',
  'o3',
  'o3-mini',
  'o1',
  'o1-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo'
]

function matchesPreference(modelId: string, preference: string): boolean {
  if (modelId === preference) {
    return true
  }
  // Family variants share the entry's prefix up to a separator
  // (`gpt-5-mini`, `gpt-5.1`, `gpt-4o-2024-11-20` with their family).
  // A bare letter continuation never matches (`gpt-4` must not claim
  // `gpt-4o`), so sibling variants (`gpt-4o-mini`) never collide with
  // their parent except through the parent entry's own family match —
  // which chooseDefaultModel resolves exact-first.
  for (const separator of ['-', '.', '_']) {
    const prefix = `${preference}${separator}`
    if (modelId.startsWith(prefix) && modelId.length > prefix.length) {
      return true
    }
  }
  return false
}

/**
 * Effective runnable selection for readiness, banner, and usage.
 * Before the first discovery settles (empty list, no error yet) the
 * persisted selection is trusted so restart never flashes
 * needs-model; once settled, only a compatible still-discovered
 * selection counts — a disappeared or incompatible selection yields
 * null so runs cannot silently target it.
 */
export function effectiveSelectedModel(
  providerId: string,
  models: readonly { readonly id: string }[],
  modelsError: string | null,
  selectedModel: string | null
): string | null {
  if (selectedModel === null) {
    return null
  }
  if (models.length === 0 && modelsError === null) {
    return selectedModel
  }
  if (!isCompatibleModelId(providerId, selectedModel)) {
    return null
  }
  return models.some((entry) => entry.id === selectedModel) ? selectedModel : null
}

/** True once a discovery round has settled (results or failure). */
export function discoverySettled(
  models: readonly { readonly id: string }[],
  modelsError: string | null
): boolean {
  return models.length > 0 || modelsError !== null
}

/**
 * Deterministic default runnable model after a successful discovery:
 * 1. the existing selection when still compatible (never churns),
 * 2. (provider-designated default: the Models API designates none —
 *    documented skip, no fabrication),
 * 3. the first preference-order match in the compatible set,
 * 4. otherwise the first compatible discovered model (adapter emits
 *    discovery sorted, so this is stable per account),
 * 5. null when nothing compatible was discovered.
 */
export function chooseDefaultModel(
  providerId: string,
  discoveredIds: readonly string[],
  selectedModel: string | null
): string | null {
  const compatible = discoveredIds.filter((id) => isCompatibleModelId(providerId, id))
  if (compatible.length === 0) {
    return null
  }
  if (selectedModel !== null && compatible.includes(selectedModel)) {
    return selectedModel
  }
  for (const preference of MODEL_PREFERENCE_ORDER) {
    const loweredPreference = preference.toLowerCase()
    const exact = compatible.find((id) => id.toLowerCase() === loweredPreference)
    if (exact !== undefined) {
      return exact
    }
    const family = compatible.find((id) => matchesPreference(id.toLowerCase(), loweredPreference))
    if (family !== undefined) {
      return family
    }
  }
  return compatible[0] ?? null
}
