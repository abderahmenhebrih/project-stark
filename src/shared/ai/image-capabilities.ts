/**
 * Shared image-generation capability model (Step 5).
 *
 * Plain TypeScript only — no Node.js or DOM APIs. Normal text models
 * do NOT generate images: only configured providers/models with real
 * image support may be selected, and the renderer/model never supply
 * provider URLs, credentials, or filesystem destinations.
 */

/** Most images produced by one generation request (1..4). */
export const MAX_GENERATED_IMAGES = 4

/** Largest single generated image, exact bytes (25 MiB). */
export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024

/** Hard per-operation provider generation budget, milliseconds (120 seconds, 0 retries). */
export const IMAGE_GENERATION_TIMEOUT_MS = 120 * 1000

/** Hard outer bound for one image_generate tool execution, milliseconds (180 seconds). */
export const IMAGE_GENERATION_OUTER_TIMEOUT_MS = 180 * 1000

/** Maximum parallel provider generation calls inside one fan-out. */
export const MAX_IMAGE_GENERATION_PARALLEL = 2

/** Longest generation prompt, Unicode code points. */
export const MAX_IMAGE_PROMPT_CODEPOINTS = 4000

/** Image model used for the OpenAI provider (fixed, main-owned). */
export const IMAGE_GENERATION_MODEL = 'gpt-image-1'

/** Closed output-size vocabulary (V1). Options outside this list are rejected, never forwarded. */
export const SUPPORTED_IMAGE_SIZES: readonly string[] = ['1024x1024', '1536x1024', '1024x1536']

/**
 * True when the provider/model offers real image generation. Only
 * OpenAI image models are implemented (`gpt-image-*`, `dall-e-*`) —
 * never fabricated for text-only models.
 */
export function providerSupportsImageGeneration(providerId: string, model: string): boolean {
  if (providerId !== 'openai') {
    return false
  }
  const lowered = model.toLowerCase()
  return lowered.startsWith('gpt-image') || lowered.startsWith('dall-e')
}
