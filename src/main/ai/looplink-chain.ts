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
import { isModelExecutable } from '../../shared/hosted-models/model-eligibility'
import {
  AiCancelledError,
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
export { isModelExecutable, resolveModelEligibility } from '../../shared/hosted-models/model-eligibility'

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
 * A present value is validated strictly against MAIN authority only:
 * non-arrays and malformed entries throw InvalidProviderRequestError,
 * unknown model ids throw ProviderModelUnavailableError, duplicates
 * are rejected, administratively unrunnable entries (known syntax but
 * incompatible with STARK's inference shape — the main-owned disabled
 * set) throw ProviderModelUnavailableError fail-closed, and an empty
 * array throws the kind-specific empty-chain safety error.
 *
 * The optional `disabledKey` legacy parameter is ACCEPTED but IGNORED
 * for authority: renderer-provided `disabledBrainModels` /
 * `disabledHeartModels` are presentation-only UI snapshots (roster
 * minus chain, session-local, never persisted). Main NEVER trusts them
 * — eligibility derives solely from the authoritative catalog +
 * compatibility state below. A forged renderer that omits/empties/
 * falsifies the disabled list gains nothing: every chain entry must
 * still be main-executable. Malformed disabled values are ignored
 * (legacy tolerance), never authoritative.
 */
export function readLoopLinkChain(
  record: Record<string, unknown>,
  key: 'brainModels' | 'heartModels',
  kind: LoopLinkKind,
  disabledKey?: 'disabledBrainModels' | 'disabledHeartModels'
): readonly string[] | null {
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
  // Main-authoritative executability: every entry must be genuinely
  // runnable (catalog + inference-shape compatibility). Renderer
  // disabled arrays are NOT consulted — see module header.
  void disabledKey
  void record
  assertLoopLinkChainExecutable(validated.chain)
  return validated.chain
}

/**
 * Main-authoritative executability gate for one validated chain.
 * Throws ProviderModelUnavailableError when any entry is known-syntax
 * but administratively unrunnable (incompatible BYOK family) or
 * otherwise not executable per shared eligibility. Unknown ids are
 * already rejected by validateLoopLinkChain; this covers the
 * incompatible/disabled class fail-closed before execution (never
 * silently skipped to the next model — the whole request fails).
 */
export function assertLoopLinkChainExecutable(chain: readonly string[]): void {
  for (const entry of chain) {
    if (!isModelExecutable(entry)) {
      throw new ProviderModelUnavailableError()
    }
  }
}

/**
 * True when the error is a user cancellation — the chain stops
 * immediately, never failing over. Covers the explicit cancelled
 * error, AbortError-style DOM cancellations, and explicit cancelled
 * markers.
 */
export function isLoopLinkCancellation(error: unknown): boolean {
  if (error instanceof AiCancelledError) {
    return true
  }
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
 *
 * ProviderGenericError is cause-aware: bare generics (no cause, e.g.
 * upstream shape violations) fail closed instead of burning the
 * whole chain, while generics carrying transient evidence (5xx,
 * 429/408, timeout/network markers) still fail over. Unknown causes
 * fail closed — never assume transience.
 */
export function isRetryableLoopLinkError(error: unknown): boolean {
  if (isLoopLinkCancellation(error)) {
    return false
  }
  if (error instanceof ProviderGenericError) {
    return isTransientGenericCause((error as { readonly cause?: unknown }).cause)
  }
  if (
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderRateLimitedError ||
    error instanceof StarkHostedUnavailableError ||
    error instanceof ProviderModelUnavailableError ||
    error instanceof ProviderStructuredOutputUnsupportedError ||
    error instanceof ProviderEmptyResponseError ||
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

/**
 * Conservative transience probe for an unclassified provider
 * failure's cause. True only for evidence of transient transport or
 * capacity behavior: HTTP 5xx/429/408, timeout/network error codes
 * and message markers, or the matching SDK error names. Everything
 * else (auth shapes, 4xx, malformed bodies, unknown shapes) is
 * non-retryable — the chain stops and the error surfaces.
 */
function isTransientGenericCause(cause: unknown): boolean {
  if (cause === null || cause === undefined) {
    return false
  }
  if (typeof cause === 'object') {
    const record = cause as { status?: unknown; code?: unknown; name?: unknown }
    if (typeof record.status === 'number') {
      if (record.status === 429 || record.status === 408) {
        return true
      }
      if (record.status >= 500 && record.status <= 599) {
        return true
      }
      return false
    }
    if (typeof record.code === 'string') {
      const transientCodes = ['ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'] as const
      if ((transientCodes as readonly string[]).includes(record.code)) {
        return true
      }
    }
    if (typeof record.name === 'string') {
      if (record.name === 'APIConnectionTimeoutError' || record.name === 'APIConnectionError' || record.name === 'RateLimitError') {
        return true
      }
    }
  }
  const message = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase()
  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('network')
  )
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
  /** Chain ids actually invoked, in attempt order (for audit). */
  readonly attemptedModelIds: readonly string[]
}

/** Serializable LoopLink execution audit shared by run-step persistence. */
export interface LoopLinkStepAudit {
  /** Total provider attempts made (1..chain length). */
  readonly attempts: number
  /** Human-safe failover note, or null when the first model served. */
  readonly failoverNote: string | null
  /** Chain ids actually invoked, in attempt order. */
  readonly attemptedModels: readonly string[]
  /** Eligible chain handed to the executor, in UI priority order. */
  readonly requestedChain: readonly string[]
}

/**
 * Builds the persistable audit for one chain outcome. Direct
 * (non-chain) single-model calls use singleModelAuditFor instead so
 * every provider-backed step carries uniform attempt metadata.
 */
export function auditOfOutcome(
  outcome: Pick<LoopLinkFailoverOutcome<unknown>, 'attempts' | 'failoverNote' | 'attemptedModelIds'>,
  requestedChain: readonly string[]
): LoopLinkStepAudit {
  return {
    attempts: outcome.attempts,
    failoverNote: outcome.failoverNote,
    attemptedModels: [...outcome.attemptedModelIds],
    requestedChain: [...requestedChain]
  }
}

/** Uniform single-attempt audit for direct (non-chain) model calls. */
export function singleModelAuditFor(modelId: string): LoopLinkStepAudit {
  return { attempts: 1, failoverNote: null, attemptedModels: [modelId], requestedChain: [modelId] }
}

/** Persistable chain audit plus the requested STARK effort. */
export interface LoopLinkStepAuditWithEffort extends LoopLinkStepAudit {
  readonly requestedEffort: string | null
}

/** Attaches the requested effort to a chain audit for step persistence. */
export function withEffort(audit: LoopLinkStepAudit, effort: string): LoopLinkStepAuditWithEffort {
  return { ...audit, requestedEffort: effort }
}

/**
 * Bounded sequential failover over one capability-filtered chain.
 * Each model is attempted at most once; the first success wins.
 * Retryable model/runtime failures advance to the next model;
 * anything else (including cancellation) throws immediately.
 * When every model fails, the last error is thrown (fail fast —
 * the best normalized final error).
 *
 * Cancellation is checked before each attempt via `isCancelled` and
 * surfaces as AiCancelledError (user cancel, never timeout) with
 * the in-progress error, if any, preserved as cause. The next model
 * is never tried after cancellation.
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
  const attemptedModelIds: string[] = []
  for (let index = 0; index < bounded.length; index += 1) {
    const modelId = bounded[index] as string
    if (options?.isCancelled?.() === true) {
      throw new AiCancelledError(lastError === null ? undefined : { cause: lastError })
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
    attemptedModelIds.push(modelId)
    try {
      const result = await invoke(modelId, assignment, index)
      const failoverNote =
        firstModelId !== null && firstModelId !== modelId ? `Switched to ${modelId} after ${firstModelId} was unavailable.` : null
      return { result, modelId, assignment, attempts, failoverNote, attemptedModelIds: [...attemptedModelIds] }
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
