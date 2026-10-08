/**
 * Renderer-side error boundary for Stage 18 Brain Work runs.
 *
 * Same principle as the other boundaries: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process Brain mapping
 * (plus the shared provider mapping for credential/network states)
 * are recognized; anything unrecognized collapses to the
 * caller-supplied fallback.
 */

export type BrainErrorKind =
  | 'invalid-request'
  | 'nothing-to-answer'
  | 'invalid-plan'
  | 'worker-failed'
  | 'synthesis-failed'
  | 'interrupted'
  | 'in-flight'
  | 'generic'

export interface NormalizedBrainError {
  readonly kind: BrainErrorKind
  readonly message: string
}

/** Stable main-process public messages for Brain operations. */
const MAIN_NOTHING_TO_ANSWER = 'There is no new message for STARK to answer.'
const MAIN_INVALID_PLAN = 'STARK could not form a valid work plan.'
const MAIN_WORKER_FAILED = 'STARK could not complete the delegated work.'
const MAIN_SYNTHESIS_FAILED = 'STARK could not complete the final response.'
const MAIN_INTERRUPTED = 'A previous work run was interrupted. Start a new one explicitly.'
const MAIN_IN_FLIGHT = 'STARK is already generating a response for this session.'
const MAIN_START_FAILED = 'We couldn’t start this work run.'
const MAIN_GENERIC = 'We couldn’t complete this work run.'

export const BRAIN_NOTHING_TO_ANSWER_MESSAGE = MAIN_NOTHING_TO_ANSWER
export const BRAIN_INVALID_PLAN_MESSAGE = MAIN_INVALID_PLAN
export const BRAIN_WORKER_FAILED_MESSAGE = MAIN_WORKER_FAILED
export const BRAIN_SYNTHESIS_FAILED_MESSAGE = MAIN_SYNTHESIS_FAILED
export const BRAIN_INTERRUPTED_MESSAGE = MAIN_INTERRUPTED
export const BRAIN_IN_FLIGHT_MESSAGE = MAIN_IN_FLIGHT
export const BRAIN_START_FAILED_MESSAGE = MAIN_START_FAILED
export const BRAIN_GENERIC_MESSAGE = MAIN_GENERIC

const KNOWN_OUTCOMES: readonly { readonly kind: BrainErrorKind; readonly mainMessage: string }[] = [
  { kind: 'nothing-to-answer', mainMessage: MAIN_NOTHING_TO_ANSWER },
  { kind: 'invalid-plan', mainMessage: MAIN_INVALID_PLAN },
  { kind: 'worker-failed', mainMessage: MAIN_WORKER_FAILED },
  { kind: 'synthesis-failed', mainMessage: MAIN_SYNTHESIS_FAILED },
  { kind: 'interrupted', mainMessage: MAIN_INTERRUPTED },
  { kind: 'in-flight', mainMessage: MAIN_IN_FLIGHT },
  { kind: 'invalid-request', mainMessage: MAIN_START_FAILED },
  { kind: 'generic', mainMessage: MAIN_GENERIC }
]

/**
 * Normalizes any thrown Brain failure to canonical display-safe copy.
 * Only `Error` instances are inspected, and only for containment of
 * a known application message.
 */
export function normalizeBrainError(error: unknown, fallback: string = BRAIN_GENERIC_MESSAGE): NormalizedBrainError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.mainMessage }
      }
    }
  }
  return { kind: 'generic', message: fallback }
}
