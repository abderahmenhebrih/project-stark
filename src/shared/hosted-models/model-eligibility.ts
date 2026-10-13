/**
 * Main-authoritative LoopLink model eligibility (shared, pure).
 *
 * SINGLE source of truth for whether a chain id may execute. Main
 * derives this independently on every request from its own catalog
 * and capability state — the renderer NEVER decides executability.
 * A forged renderer must not be able to omit/empty/falsify a disabled
 * list (or send a stale roster) and thereby execute a model.
 *
 * What "disabled" means here (traced to its real source):
 * - Renderer "disabled" is UI chain membership only: roster minus the
 *   enabled chain, session-local, never persisted (schema v20 stores
 *   no chain configuration). Main executes ONLY chain entries, so
 *   omission from the chain IS the enforcement — there is no separate
 *   persistent user-disabled set for main to consult.
 * - Main-authoritative "not executable" is therefore: unknown id,
 *   malformed entry, or a known-syntax entry that cannot serve STARK's
 *   inference shape (BYOK incompatible families: audio, image,
 *   embeddings, moderation, realtime, legacy completions). Those fail
 *   closed at validation, before execution, regardless of any
 *   renderer-provided disabled arrays (which are presentation-only
 *   legacy and IGNORED for authority).
 *
 * Distinctions preserved (never confused):
 * - unknown: not in any catalog/route (rejected).
 * - disabled/incompatible: known syntax but administratively unrunnable
 *   (rejected fail-closed, never silently skipped to the next model).
 * - unsupported for capability: model cannot serve THIS phase
 *   (structured/vision) — filtered per phase with ordered failover to
 *   the next enabled model (see filterLoopLinkChainForCapability), not
 *   a validation rejection.
 * - temporarily unavailable provider (no credential, sign-in required,
 *   capacity/rate-limit, network): runtime failure at execution, fails
 *   over only when retryable, never confused with disabled.
 */

import { isHostedBuiltinModel } from './stark-model-map'
import { isCompatibleModelId } from './openai-compatibility'

/** BYOK chain entry syntax: `openai:<slug>` (main keeps credential authority). */
const OPENAI_CHAIN_ENTRY_PATTERN = /^openai:[A-Za-z0-9._-]+$/

/** Maximum code points for one BYOK slug inside a chain entry. */
const MAX_OPENAI_CHAIN_SLUG_CODEPOINTS = 64

/** Why a chain id is not executable (for fail-closed validation). */
export type ModelIneligibilityReason = 'unknown' | 'incompatible' | 'malformed'

export type ModelEligibility =
  | { readonly executable: true }
  | { readonly executable: false; readonly reason: ModelIneligibilityReason }

/**
 * Resolves one LoopLink chain id to its main-authoritative
 * executability. Pure and total: malformed inputs (non-strings, NUL,
 * overlong) are `malformed`; well-formed but unroutable ids are
 * `unknown`; well-formed routable ids that cannot serve STARK's
 * inference shape are `incompatible` (administratively disabled);
 * everything else is executable (per-phase capability filtering
 * happens separately, with failover).
 */
export function resolveModelEligibility(modelId: unknown): ModelEligibility {
  if (typeof modelId !== 'string' || modelId === '' || modelId.length > 128 || modelId.includes('\0')) {
    return { executable: false, reason: 'malformed' }
  }
  if (modelId.startsWith('builtin:')) {
    return isHostedBuiltinModel(modelId)
      ? { executable: true }
      : { executable: false, reason: 'unknown' }
  }
  if (modelId.startsWith('openai:')) {
    if (!OPENAI_CHAIN_ENTRY_PATTERN.test(modelId)) {
      return { executable: false, reason: 'unknown' }
    }
    const slug = modelId.slice('openai:'.length)
    if (slug === '' || [...slug].length > MAX_OPENAI_CHAIN_SLUG_CODEPOINTS) {
      return { executable: false, reason: 'unknown' }
    }
    // Administratively disabled: known syntax but incompatible with
    // STARK's Responses-API text shape (audio/embeddings/etc.).
    return isCompatibleModelId('openai', slug)
      ? { executable: true }
      : { executable: false, reason: 'incompatible' }
  }
  return { executable: false, reason: 'unknown' }
}

/** True when one chain id may execute (main-authoritative). */
export function isModelExecutable(modelId: unknown): boolean {
  return resolveModelEligibility(modelId).executable
}
