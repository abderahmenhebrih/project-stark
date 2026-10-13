/**
 * Shared OpenAI (BYOK) model compatibility (single source of truth).
 *
 * Pure, dependency-free classification of raw provider model-list ids
 * against STARK's current inference call shape: exactly one
 * Responses-API text call through the single registered `openai`
 * route. Only models proven compatible with that call shape are
 * runnable. Exclusions are narrow and named: known non-text
 * modalities (audio, image, embeddings, moderation, realtime) and
 * legacy completions families that predate the Responses API.
 * Everything else is a text chat candidate — a new flagship that
 * follows the same shape works without a client update.
 *
 * Main and renderer share this file without drift: main enforces it
 * authoritatively at LoopLink chain validation (a forged renderer must
 * never execute an incompatible model by omitting a disabled list),
 * while the renderer uses it for library derivation and display.
 * No credentials, no network, no persistence here.
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
