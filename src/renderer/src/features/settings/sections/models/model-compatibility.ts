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

export interface DiscoveredProviderModel {
  readonly providerId: string
  readonly modelId: string
  readonly displayName: string
  readonly compatible: boolean
  /** Machine-readable exclusion reason for incompatible entries, else null. */
  readonly reason: string | null
}

interface IncompatibleFamily {
  readonly match: (id: string) => boolean
  readonly reason: string
}

/** Known non-Responses-text families. Narrow by design — see module header. */
const INCOMPATIBLE_FAMILIES: readonly IncompatibleFamily[] = [
  { match: (id) => id.includes('whisper'), reason: 'audio-transcription' },
  { match: (id) => id.includes('tts') || id.includes('audio'), reason: 'audio-model' },
  { match: (id) => id.includes('dall-e') || id.startsWith('dalle'), reason: 'image-generation' },
  { match: (id) => id.includes('embed'), reason: 'embedding' },
  { match: (id) => id.includes('moderation'), reason: 'moderation' },
  { match: (id) => id.includes('realtime'), reason: 'realtime-api' },
  { match: (id) => id.includes('computer-use'), reason: 'agent-harness' },
  { match: (id) => id.includes('jukebox'), reason: 'music' },
  { match: (id) => id.includes('-instruct'), reason: 'legacy-instruct' },
  {
    match: (id) =>
      id.startsWith('babbage-') ||
      id.startsWith('davinci-') ||
      id.startsWith('curie-') ||
      id.startsWith('ada-') ||
      id.startsWith('text-'),
    reason: 'legacy-completions'
  }
]

/**
 * Classifies one discovered model id. Only the `openai` provider has
 * a registered runtime route in this build, so any other provider id
 * is incompatible by construction (no routes invented).
 */
export function classifyDiscoveredModel(providerId: string, modelId: string): DiscoveredProviderModel {
  const displayName = modelId
  if (providerId !== 'openai') {
    return { providerId, modelId, displayName, compatible: false, reason: 'no-runtime-route' }
  }
  if (modelId.trim() === '' || /\s/.test(modelId)) {
    return { providerId, modelId, displayName, compatible: false, reason: 'invalid-id' }
  }
  const id = modelId.toLowerCase()
  for (const family of INCOMPATIBLE_FAMILIES) {
    if (family.match(id)) {
      return { providerId, modelId, displayName, compatible: false, reason: family.reason }
    }
  }
  return { providerId, modelId, displayName, compatible: true, reason: null }
}

/** True when one model id is runnable through the provider route. */
export function isCompatibleModelId(providerId: string, modelId: string): boolean {
  return classifyDiscoveredModel(providerId, modelId).compatible
}

/** Compatible ids from a raw discovery list, order-preserving, deduped. */
export function compatibleModelIds(
  providerId: string,
  models: readonly { readonly id: string }[]
): readonly string[] {
  const out: string[] = []
  for (const entry of models) {
    if (isCompatibleModelId(providerId, entry.id) && !out.includes(entry.id)) {
      out.push(entry.id)
    }
  }
  return out
}

/**
 * Explicit compatibility preference order for default selection.
 * Ranking only: every entry is a long-standing real OpenAI chat id,
 * and only ids actually present in the discovery result can win, so
 * an unknown or retired name simply never matches. Dated snapshots
 * (e.g. `gpt-4o-2024-11-20`) rank with their family via prefix match.
 * Specific families precede their prefixes (`gpt-4o` before `gpt-4`).
 */
export const MODEL_PREFERENCE_ORDER: readonly string[] = [
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
  // Dated snapshots rank with their family (e.g. `gpt-4o-2024-11-20`
  // with `gpt-4o`): the remainder must start with a digit so sibling
  // variants (`gpt-4o-mini`) never collide with their parent.
  for (const separator of ['-', '.']) {
    const prefix = `${preference}${separator}`
    if (modelId.startsWith(prefix)) {
      const remainder = modelId.slice(prefix.length)
      if (remainder !== '' && remainder[0] !== undefined && /[0-9]/.test(remainder[0])) {
        return true
      }
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
    const match = compatible.find((id) => matchesPreference(id.toLowerCase(), preference))
    if (match !== undefined) {
      return match
    }
  }
  return compatible[0] ?? null
}
