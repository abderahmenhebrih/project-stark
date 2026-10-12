/**
 * STARK hosted model allowlist (server copy).
 *
 * EXACT builtin → OpenRouter mapping for the 15 STARK Free models,
 * plus evidence-based capability flags from the OpenRouter catalog
 * (`supported_parameters`, `architecture.input_modalities`). This
 * file is intentionally dependency-free (no Deno or Node APIs) so
 * the desktop test suite can import it for parity checks.
 *
 * The desktop source of truth lives at
 * `src/shared/hosted-models/stark-model-map.ts`; a parity test
 * asserts the two tables never drift. Never add an entry here
 * without the catalog evidence, and never substitute another model.
 */

export interface HostedModelRoute {
  readonly builtinId: string
  readonly openRouterId: string
  readonly structuredOutputs: boolean
  readonly reasoningEffort: boolean
  readonly supportsVision: boolean
}

export const HOSTED_MODEL_ROUTES: readonly HostedModelRoute[] = [
  { builtinId: 'builtin:muse-spark-1.3', openRouterId: 'meta/muse-spark-1.3', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:glm-5.3-flash', openRouterId: 'z-ai/glm-5.3-flash', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:deepseek-v4.1-flash', openRouterId: 'deepseek/deepseek-v4.1-flash', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:gpt-5.6-luna', openRouterId: 'openai/gpt-5.6-luna', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:gemini-2.5-flash', openRouterId: 'google/gemini-2.5-flash', structuredOutputs: true, reasoningEffort: false, supportsVision: true },
  { builtinId: 'builtin:claude-haiku-5.5', openRouterId: 'anthropic/claude-haiku-5.5', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:minimax-m3', openRouterId: 'minimax/minimax-m3', structuredOutputs: true, reasoningEffort: false, supportsVision: true },
  { builtinId: 'builtin:kimi-k2.7-code', openRouterId: 'moonshotai/kimi-k2.7-code', structuredOutputs: true, reasoningEffort: false, supportsVision: true },
  { builtinId: 'builtin:mimo-v2.6-pro', openRouterId: 'xiaomi/mimo-v2.6-pro', structuredOutputs: true, reasoningEffort: false, supportsVision: true },
  { builtinId: 'builtin:mimo-v2.6-flash', openRouterId: 'xiaomi/mimo-v2.6-flash', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:nemotron-3.5-lightning', openRouterId: 'nvidia/nemotron-3.5-lightning', structuredOutputs: true, reasoningEffort: true, supportsVision: false },
  { builtinId: 'builtin:deepseek-v4-flash', openRouterId: 'deepseek/deepseek-v4-flash', structuredOutputs: true, reasoningEffort: true, supportsVision: false },
  { builtinId: 'builtin:muse-spark-1.2', openRouterId: 'meta/muse-spark-1.2', structuredOutputs: true, reasoningEffort: true, supportsVision: true },
  { builtinId: 'builtin:longcat-2.0', openRouterId: 'meituan/longcat-2.0', structuredOutputs: false, reasoningEffort: false, supportsVision: false },
  { builtinId: 'builtin:mistral-large-4', openRouterId: 'mistralai/mistral-large-4-0', structuredOutputs: true, reasoningEffort: true, supportsVision: true }
]

export const HOSTED_MODEL_COUNT = 15

function dashesOf(builtinId: string): string {
  const separator = builtinId.indexOf(':')
  if (separator === -1) {
    return builtinId
  }
  return `${builtinId.slice(0, separator + 1)}${builtinId.slice(separator + 1).replace(/\./g, '-')}`
}

/**
 * Resolves one desktop `builtin:<slug>` id (dot or dash
 * transcription) to its route, or null. Anything else is rejected so
 * the endpoint can never serve as an unrestricted upstream proxy.
 */
export function resolveHostedRoute(modelId: string): HostedModelRoute | null {
  if (typeof modelId !== 'string' || modelId === '') {
    return null
  }
  for (const route of HOSTED_MODEL_ROUTES) {
    if (modelId === route.builtinId || modelId === dashesOf(route.builtinId)) {
      return route
    }
  }
  return null
}
