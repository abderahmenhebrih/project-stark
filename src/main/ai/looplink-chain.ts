/**
 * Main-process LoopLink execution runtime (Brain/Heart ordered failover).
 *
 * LoopLinks control real model execution: each inference phase walks
 * its chain in UI order — try model 1, on a retryable model/runtime
 * failure try model 2, and so on. Disabled models never participate
 * (only enabled ids arrive in the payload). Sequential only, each
 * model attempted at most once per phase, capped at 5.
 *
 * Failure classification (never hide security errors behind failover):
 * - FAIL OVER: provider timeout, network unreachable, hosted service
 *   unavailable, capacity/rate limit, upstream temporary error,
 *   model unavailable, capability unsupported for the phase,
 *   invalid provider response where retry is safe (empty/generic),
 *   model-output validation failures (a different model may serve).
 * - NEVER fail over: user cancellation, auth/sign-in required,
 *   credential/permission failures, malformed local requests,
 *   session/workspace ownership failures, approval blocks, deadline
 *   exhaustion, in-flight guards, non-model application errors.
 */

import {
  filterLoopLinkChainForCapability,
  isKnownLoopLinkModelId,
  loopLinkEntryAssignment,
  validateLoopLinkChain,
  MAX_LOOPLINK_CHAIN_MODELS,
  type LoopLinkCapabilityNeeds
} from '../../shared/hosted-models/looplink-chains'
import {
  GenerationInFlightError,
  InvalidProviderRequestError,
  ProviderCredentialMissingError,
  ProviderEmptyResponseError,
  ProviderForbiddenError,
  ProviderGenericError,
  ProviderInvalidCredentialError,
  ProviderModelMissingError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderStructuredOutputUnsupportedError,
  ProviderTimeoutError,
  SecureStorageUnavailableError,
  StarkHostedSignInRequiredError,
  StarkHostedUnavailableError,
  UnknownProviderError
} from './errors'
import {
  BrainNothingToAnswerError,
  InvalidBrainPlanError,
  InvalidBrainRequestError,
  InvalidBrainSynthesisError,
  InvalidWorkerOutputError
} from './ai-brain-errors'
import { InvalidProposalOutputError } from './ai-proposal-errors'
import { InvalidChangeSetOutputError } from './ai-change-set-errors'
import { VisionUnsupportedForModelError } from './ai-attachment-context'
import { HeartImageUnsupportedError } from '../heart/heart-errors'
import { PendingApprovalBlockedError } from '../worker-tools/worker-tool-errors'
import {
  SessionNotFoundError,
  SessionWorkspaceMismatchError,
  SessionWorkspaceUnavailableError
} from '../sessions/errors'

export { MAX_LOOPLINK_CHAIN_MODELS }

/** Brain chain arrived present-but-empty: fail safely, never inject a model. */
export class LoopLinkBrainEmptyError extends Error {
  override readonly name = 'LoopLinkBrainEmptyError'

  constructor() {
    super('looplink_brain_empty')
  }
}

/** Heart chain arrived present-but-empty during a Heart-required phase. */
export class LoopLinkHeartEmptyError extends Error {
  override readonly name = 'LoopLinkHeartEmptyError'

  constructor() {
    super('looplink_heart_empty')
  }
}

export function isLoopLinkEmptyError(error: unknown): boolean {
  return error instanceof LoopLinkBrainEmptyError || error instanceof LoopLinkHeartEmptyError
}

export type LoopLinkKind = 'brain' | 'heart'

function emptyErrorFor(kind: LoopLinkKind): LoopLinkBrainEmptyError | LoopLinkHeartEmptyError {
  return kind === 'brain' ? new LoopLinkBrainEmptyError() : new LoopLinkHeartEmptyError()
}

/**
 * Reads one LoopLink chain from a request record. Absent/null/undefined
 * means legacy behavior (no chain — caller keeps its previous routing).
 * A present value is validated strictly: non-arrays and malformed
 * entries throw InvalidProviderRequestError, unknown model ids throw
 * ProviderModelUnavailableError, duplicates are rejected, and an
 * empty array throws the kind-specific empty-chain safety error.
 */
export function readLoopLinkChain(record: Record<string, unknown>, key: 'brainModels' | 'heartModels', kind: LoopLinkKind): readonly string[] | null {
  if (!(key in record) || record[key] === undefined || record[key] === null) {
    return null
  }
  const validated = validateLoopLinkChain(record[key])
  if (!validated.ok) {
    if (validated.reason === 'empty') {
      throw emptyErrorFor(kind)
    }
    if (validated.reason === 'unknown_model') {
      throw new ProviderModelUnavailableError()
    }
    throw new InvalidProviderRequestError(`looplink ${kind} chain is invalid`)
  }
  return validated.chain
}

/**
 * True when the error is a user cancellation — the chain stops
 * immediately, never failing over. Covers AbortError-style DOM
 * cancellations and explicit cancelled markers.
 */
export function isLoopLinkCancellation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const record = error as Record<string, unknown>
  if (record['cancelled'] === true || record['canceled'] === true) {
    return true
  }
  const name = typeof record['name'] === 'string' ? (record['name'] as string) : ''
  const message = error instanceof Error ? error.message : ''
  if (name === 'AbortError' && /cancel/i.test(message)) {
    return true
  }
  return false
}

/**
 * Failure classification: true only for retryable model/runtime
 * failures where trying the next LoopLink model is safe. Everything
 * else (auth, permissions, malformed requests, ownership, guards,
 * approvals, cancellations, non-model errors) returns false so the
 * original error surfaces unchanged.
 */
export function isRetryableLoopLinkError(error: unknown): boolean {
  if (isLoopLinkCancellation(error)) {
    return false
  }
  if (
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderRateLimitedError ||
    error instanceof StarkHostedUnavailableError ||
    error instanceof ProviderModelUnavailableError ||
    error instanceof ProviderStructuredOutputUnsupportedError ||
    error instanceof ProviderEmptyResponseError ||
    error instanceof ProviderGenericError ||
    error instanceof VisionUnsupportedForModelError ||
    error instanceof HeartImageUnsupportedError ||
    error instanceof InvalidBrainPlanError ||
    error instanceof InvalidWorkerOutputError ||
    error instanceof InvalidBrainSynthesisError ||
    error instanceof InvalidProposalOutputError ||
    error instanceof InvalidChangeSetOutputError
  ) {
    return true
  }
  if (
    error instanceof StarkHostedSignInRequiredError ||
    error instanceof ProviderInvalidCredentialError ||
    error instanceof ProviderForbiddenError ||
    error instanceof ProviderCredentialMissingError ||
    error instanceof ProviderModelMissingError ||
    error instanceof SecureStorageUnavailableError ||
    error instanceof UnknownProviderError ||
    error instanceof GenerationInFlightError ||
    error instanceof InvalidProviderRequestError ||
    error instanceof InvalidBrainRequestError ||
    error instanceof BrainNothingToAnswerError ||
    error instanceof PendingApprovalBlockedError ||
    error instanceof SessionNotFoundError ||
    error instanceof SessionWorkspaceMismatchError ||
    error instanceof SessionWorkspaceUnavailableError
  ) {
    return false
  }
  return false
}

export interface LoopLinkAttempt {
  readonly providerId: 'stark' | 'openai'
  readonly model: string
}

/**
 * Resolves one validated chain entry to its provider assignment.
 * Returns null for entries that cannot route (unknown ids fail
 * closed — callers treat null as a skip, never a proxy).
 */
export function loopLinkAssignmentFor(modelId: string): LoopLinkAttempt | null {
  const assignment = loopLinkEntryAssignment(modelId)
  if (assignment === null) {
    return null
  }
  return { providerId: assignment.providerId, model: assignment.model }
}

export interface LoopLinkFailoverOutcome<T> {
  /** The successful invocation result. */
  readonly result: T
  /** The chain id that actually executed (for usage audit). */
  readonly modelId: string
  /** Provider assignment that served the call. */
  readonly assignment: LoopLinkAttempt
  /** Total provider attempts made (1..chain length). */
  readonly attempts: number
  /** Human-safe failover note, or null when the first model served. */
  readonly failoverNote: string | null
}

/**
 * Bounded sequential failover over one capability-filtered chain.
 * Each model is attempted at most once; the first success wins.
 * Retryable model/runtime failures advance to the next model;
 * anything else (including cancellation) throws immediately.
 * When every model fails, the last error is thrown (fail fast —
 * the best normalized final error).
 *
 * Cancellation is checked before each attempt via `isCancelled`.
 */
export async function runLoopLinkChain<T>(
  chain: readonly string[],
  invoke: (modelId: string, assignment: LoopLinkAttempt, attemptIndex: number) => Promise<T>,
  options?: { readonly isCancelled?: () => boolean }
): Promise<LoopLinkFailoverOutcome<T>> {
  let lastError: unknown = null
  let firstModelId: string | null = null
  const bounded = chain.slice(0, MAX_LOOPLINK_CHAIN_MODELS)
  let attempts = 0
  for (let index = 0; index < bounded.length; index += 1) {
    const modelId = bounded[index] as string
    if (options?.isCancelled?.() === true) {
      if (lastError !== null) {
        throw lastError
      }
      throw new InvalidBrainPlanError()
    }
    const assignment = loopLinkAssignmentFor(modelId)
    if (assignment === null) {
      lastError = new ProviderModelUnavailableError()
      continue
    }
    if (firstModelId === null) {
      firstModelId = modelId
    }
    attempts += 1
    try {
      const result = await invoke(modelId, assignment, index)
      const failoverNote =
        firstModelId !== null && firstModelId !== modelId ? `Switched to ${modelId} after ${firstModelId} was unavailable.` : null
      return { result, modelId, assignment, attempts, failoverNote }
    } catch (error) {
      lastError = error
      if (!isRetryableLoopLinkError(error)) {
        throw error
      }
    }
  }
  if (lastError !== null) {
    throw lastError
  }
  throw new ProviderModelUnavailableError()
}

/**
 * Prepares one chain for a phase: capability-filters to eligible
 * entries in UI order. Returns the eligible list (possibly empty —
 * callers fail with the phase capability error when nothing can
 * serve). Unknown/unroutable entries are dropped here; validated
 * chains only contain known ids, so a drop means a capability skip.
 */
export function eligibleLoopLinkModels(chain: readonly string[], needs: LoopLinkCapabilityNeeds): readonly string[] {
  return filterLoopLinkChainForCapability(chain, needs)
}

/** Re-export for callers that only need the known-id check. */
export { isKnownLoopLinkModelId }
