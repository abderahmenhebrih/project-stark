/**
 * Shared LoopLink chain contract (Brain/Heart ordered model failover).
 *
 * A LoopLink is an ORDERED list of enabled stable model ids. The
 * runtime tries the first model; on a retryable model/runtime
 * failure it tries the next, in UI order. Disabled models never
 * participate (the renderer only sends enabled ids). At most 5
 * models per chain, each attempted at most once per inference
 * phase, sequentially — no parallel calls, no retry loops.
 *
 * Plain TypeScript only — no Node.js or DOM APIs — so main,
 * renderer, and tests share it without drift. Main validates
 * authoritatively on every request; the renderer copy is only for
 * display/payload assembly.
 */

import {
  isHostedBuiltinModel,
  resolveHostedModelRoute
} from './stark-model-map'
import { modelSupportsVision } from '../ai/attachment-capabilities'

/** Product-locked LoopLink bound: at most 5 models per chain. */
export const MAX_LOOPLINK_CHAIN_MODELS = 5

/** BYOK chain entry syntax: `openai:<slug>` (main keeps credential authority). */
const OPENAI_CHAIN_ENTRY_PATTERN = /^openai:[A-Za-z0-9._-]+$/

/** Maximum code points for one BYOK slug inside a chain entry. */
const MAX_OPENAI_CHAIN_SLUG_CODEPOINTS = 64

/**
 * Validation failure reasons for one LoopLink chain value. `empty`
 * maps to the `looplink_brain_empty` / `looplink_heart_empty`
 * safety errors; every other reason is a malformed-chain rejection.
 */
export type LoopLinkChainInvalidReason =
  | 'not_array'
  | 'empty'
  | 'too_many'
  | 'bad_entry'
  | 'duplicate'
  | 'unknown_model'

export type LoopLinkChainValidation =
  | { readonly ok: true; readonly chain: readonly string[] }
  | { readonly ok: false; readonly reason: LoopLinkChainInvalidReason }

/**
 * Validates one raw LoopLink chain value from an IPC payload. Rules:
 * array, 1..5 entries, each a non-empty string with no NUL, an exact
 * known model id (`builtin:*` allowlisted Free id or bounded
 * `openai:*` connected-provider entry — never an arbitrary upstream
 * id), no duplicates (order-preserving, first occurrence wins is
 * NOT applied — duplicates are rejected deterministically).
 */
export function validateLoopLinkChain(value: unknown): LoopLinkChainValidation {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'not_array' }
  }
  if (value.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  if (value.length > MAX_LOOPLINK_CHAIN_MODELS) {
    return { ok: false, reason: 'too_many' }
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || entry.length > 128 || entry.includes('\0')) {
      return { ok: false, reason: 'bad_entry' }
    }
    if (seen.has(entry)) {
      return { ok: false, reason: 'duplicate' }
    }
    seen.add(entry)
    if (!isKnownLoopLinkModelId(entry)) {
      return { ok: false, reason: 'unknown_model' }
    }
  }
  return { ok: true, chain: [...value] as readonly string[] }
}

/**
 * True for exactly the ids a LoopLink may contain: the 15
 * allowlisted STARK Free `builtin:*` ids, or a bounded `openai:*`
 * connected-provider entry. Anything else (including arbitrary
 * upstream ids) is rejected so the renderer can never inject an
 * unrestricted proxy target.
 */
export function isKnownLoopLinkModelId(modelId: string): boolean {
  if (modelId.startsWith('builtin:')) {
    return isHostedBuiltinModel(modelId)
  }
  if (modelId.startsWith('openai:')) {
    if (!OPENAI_CHAIN_ENTRY_PATTERN.test(modelId)) {
      return false
    }
    const slug = modelId.slice('openai:'.length)
    return slug !== '' && [...slug].length <= MAX_OPENAI_CHAIN_SLUG_CODEPOINTS
  }
  return false
}

/**
 * Provider assignment for one validated chain entry. `builtin:*`
 * routes through the STARK hosted provider; `openai:*` routes
 * through the connected BYOK provider with the slug as the model.
 */
export function loopLinkEntryAssignment(modelId: string): { providerId: 'stark' | 'openai'; model: string } | null {
  if (modelId.startsWith('builtin:')) {
    if (!isHostedBuiltinModel(modelId)) {
      return null
    }
    return { providerId: 'stark', model: modelId }
  }
  if (modelId.startsWith('openai:') && isKnownLoopLinkModelId(modelId)) {
    return { providerId: 'openai', model: modelId.slice('openai:'.length) }
  }
  return null
}

export interface LoopLinkCapabilityNeeds {
  /** Phase requires structured output (plan, proposals). */
  readonly needsStructured: boolean
  /** Phase must carry image attachments. */
  readonly needsVision: boolean
}

/**
 * Capability-aware eligibility for one chain entry. A model that
 * cannot serve the phase is skipped (fail over to the next enabled
 * model) — never sent knowingly unsupported parameters:
 * - structured output required but the model advertises none
 *   (evidence-based hosted flag; BYOK entries assumed capable).
 * - vision required but the model is not vision-capable.
 */
export function isLoopLinkModelCapable(modelId: string, needs: LoopLinkCapabilityNeeds): boolean {
  if (needs.needsStructured && !loopLinkModelSupportsStructured(modelId)) {
    return false
  }
  if (needs.needsVision && !loopLinkModelSupportsVision(modelId)) {
    return false
  }
  return true
}

/** Filters a validated chain to phase-capable entries, preserving UI order. */
export function filterLoopLinkChainForCapability(
  chain: readonly string[],
  needs: LoopLinkCapabilityNeeds
): readonly string[] {
  return chain.filter((modelId) => isLoopLinkModelCapable(modelId, needs))
}

/** Evidence-based structured-output support for one chain entry. */
export function loopLinkModelSupportsStructured(modelId: string): boolean {
  if (modelId.startsWith('builtin:')) {
    return resolveHostedModelRoute(modelId)?.structuredOutputs ?? false
  }
  if (modelId.startsWith('openai:')) {
    return true
  }
  return false
}

/** Vision support for one chain entry (hosted map or BYOK heuristic). */
export function loopLinkModelSupportsVision(modelId: string): boolean {
  const assignment = loopLinkEntryAssignment(modelId)
  if (assignment === null) {
    return false
  }
  return modelSupportsVision(assignment.providerId, assignment.model)
}
