import type { RecoveryFailureCategory, RecoveryMode } from '../../shared/recovery/types'
import {
  ProviderInvalidCredentialError,
  ProviderForbiddenError,
  ProviderRateLimitedError,
  ProviderNetworkError,
  ProviderTimeoutError,
  ProviderModelUnavailableError,
  ProviderStructuredOutputUnsupportedError,
  ProviderGenericError
} from '../ai/errors'

/**
 * Pure recovery policy (Stage 21): deterministic, zero provider calls,
 * zero database side effects. Maps typed main-process errors to stable
 * recoverable categories and decides exactly one of none / handoff /
 * auto_once. The renderer never participates — decisions happen from
 * typed errors before public message flattening.
 */

export const RECOVERABLE_CATEGORIES: readonly RecoveryFailureCategory[] = [
  'provider-rate-limit',
  'provider-network',
  'provider-timeout',
  'provider-unavailable',
  'model-unavailable',
  'structured-output-unsupported'
]

const RECOVERABLE_SET: ReadonlySet<string> = new Set<string>(RECOVERABLE_CATEGORIES)

export type RecoveryDecision = 'none' | 'handoff' | 'auto_once'

export interface DecideRecoveryInput {
  readonly mode: RecoveryMode
  readonly failureCategory: string | null
  readonly isRecoveryTarget: boolean
  readonly existingEvent: boolean
}

/**
 * Pure decision function. Returns exactly one decision with no side
 * effects and no provider calls.
 *
 * - Recovery targets never auto-recover (depth <= 1).
 * - Duplicate source requests never create a second handoff.
 * - `off` and non-recoverable categories never recover.
 */
export function decideRecovery(input: DecideRecoveryInput): RecoveryDecision {
  if (input.isRecoveryTarget) {
    return 'none'
  }
  if (input.existingEvent) {
    return 'none'
  }
  if (input.mode === 'off') {
    return 'none'
  }
  if (input.failureCategory === null || !RECOVERABLE_SET.has(input.failureCategory)) {
    return 'none'
  }
  if (input.mode === 'handoff') {
    return 'handoff'
  }
  return 'auto_once'
}

/** True for the six stable recoverable categories only. */
export function isRecoverableCategory(category: string | null): boolean {
  return category !== null && RECOVERABLE_SET.has(category)
}

/**
 * Maps a typed main-process error to its stable recovery category, or
 * null when the failure must never trigger automatic continuity.
 * Only the six recoverable provider/model availability conditions map;
 * auth, permission, validation, storage, transaction, looplink, heart,
 * renderer, and cancellation failures stay null.
 */
export function failureCategoryFor(error: unknown): RecoveryFailureCategory | null {
  if (error instanceof ProviderRateLimitedError) {
    return 'provider-rate-limit'
  }
  if (error instanceof ProviderNetworkError) {
    return 'provider-network'
  }
  if (error instanceof ProviderTimeoutError) {
    return 'provider-timeout'
  }
  if (error instanceof ProviderGenericError) {
    return 'provider-unavailable'
  }
  if (error instanceof ProviderModelUnavailableError) {
    return 'model-unavailable'
  }
  if (error instanceof ProviderStructuredOutputUnsupportedError) {
    return 'structured-output-unsupported'
  }
  void ProviderInvalidCredentialError
  void ProviderForbiddenError
  return null
}

/** Human-safe label for a failure category (renderer copy, no bodies). */
export function failureCategoryLabel(category: string): string {
  switch (category) {
    case 'provider-rate-limit':
      return 'Rate limit'
    case 'provider-network':
      return 'Network'
    case 'provider-timeout':
      return 'Timeout'
    case 'provider-unavailable':
      return 'Provider unavailable'
    case 'model-unavailable':
      return 'Model unavailable'
    case 'structured-output-unsupported':
      return 'Structured output unsupported'
    default:
      return 'Provider failure'
  }
}
