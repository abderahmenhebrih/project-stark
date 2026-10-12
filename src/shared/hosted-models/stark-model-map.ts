/**
 * Canonical STARK hosted model map (Free catalog → upstream route).
 *
 * ONE source of truth for the 15 STARK Free `builtin:<slug>` ids and
 * their exact corresponding OpenRouter model ids, plus
 * evidence-based capability flags. Plain TypeScript only — no Node.js
 * or DOM APIs — so main, renderer, and tests share it without drift.
 *
 * Evidence: OpenRouter catalog `/api/v1/models` (verified live) for
 * ids, `supported_parameters`, and `architecture.input_modalities`;
 * the `mistralai/mistral-large-4-0` model page confirms the
 * "Mistral Large 4" display name. Nothing here is approximated:
 * - `structuredOutputs` mirrors catalog `structured_outputs` support
 *   (LongCat 2.0 advertises none — structured calls must fail
 *   honestly instead of being attempted blindly).
 * - `reasoningEffort` mirrors catalog `reasoning_effort` support
 *   (absent for Gemini 2.5 Flash, MiniMax M3, Kimi K2.7 Code,
 *   MiMo-V2.6-Pro — effort must be omitted, never faked).
 * - `supportsVision` mirrors catalog image input modality (absent
 *   for Nemotron 3.5 Lightning, DeepSeek V4 Flash, LongCat 2.0).
 *
 * The server-side Edge Function carries its own copy of this table
 * (Deno self-containment); a parity test asserts the two never drift.
 */

export interface StarkHostedModelRoute {
  /** Desktop stable id, e.g. `builtin:gpt-5.6-luna`. */
  readonly builtinId: string
  /** Exact OpenRouter model id — never approximated. */
  readonly openRouterId: string
  /** Catalog `structured_outputs` support (evidence-based). */
  readonly structuredOutputs: boolean
  /** Catalog `reasoning_effort` support (evidence-based). */
  readonly reasoningEffort: boolean
  /** Catalog image input modality (evidence-based). */
  readonly supportsVision: boolean
}

export const STARK_HOSTED_MODEL_ROUTES: readonly StarkHostedModelRoute[] = [
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

/** Product-locked hosted catalog size. Exactly 15. */
export const STARK_HOSTED_MODEL_COUNT = 15

/**
 * Resolves one desktop `builtin:<slug>` id to its upstream route, or
 * null when the id is not one of the 15 allowlisted entries. The
 * desktop may send either dot or dash slug transcriptions
 * (`builtin:muse-spark-1.3` / `builtin:muse-spark-1-3`); both resolve
 * to the same entry — anything else is rejected, so the endpoint can
 * never serve as an unrestricted upstream proxy.
 */
export function resolveHostedModelRoute(modelId: string): StarkHostedModelRoute | null {
  if (typeof modelId !== 'string' || modelId === '') {
    return null
  }
  for (const route of STARK_HOSTED_MODEL_ROUTES) {
    if (modelId === route.builtinId || modelId === dashesOf(route.builtinId)) {
      return route
    }
  }
  return null
}

/** True for exactly the 15 allowlisted desktop ids (either transcription). */
export function isHostedBuiltinModel(modelId: string): boolean {
  return resolveHostedModelRoute(modelId) !== null
}

/** Evidence-based image-input support for one desktop builtin id. */
export function hostedModelSupportsVision(modelId: string): boolean {
  return resolveHostedModelRoute(modelId)?.supportsVision ?? false
}

/** Canonical dot transcription for a dash-transcribed builtin id. */
function dashesOf(builtinId: string): string {
  const separator = builtinId.indexOf(':')
  if (separator === -1) {
    return builtinId
  }
  return `${builtinId.slice(0, separator + 1)}${builtinId.slice(separator + 1).replace(/\./g, '-')}`
}
