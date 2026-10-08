/**
 * Renderer-side error boundary for explicit project-context
 * operations.
 *
 * Same principle as the session boundary: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process context mapping
 * are recognized; anything unrecognized collapses to the
 * caller-supplied fallback.
 */

export type ContextErrorKind =
  | 'too-large'
  | 'total-too-large'
  | 'too-many'
  | 'unsupported'
  | 'unavailable'
  | 'invalid-range'
  | 'generic'

export interface NormalizedContextError {
  readonly kind: ContextErrorKind
  readonly message: string
}

/** Stable main-process public messages for context operations. */
const MAIN_ITEM_TOO_LARGE_MESSAGE = 'This context item is too large to attach.'
const MAIN_TOTAL_TOO_LARGE_MESSAGE = 'The total attached context is too large.'
const MAIN_TOO_MANY_MESSAGE = 'You can attach at most 20 context items to one message.'
const MAIN_UNSUPPORTED_MESSAGE = 'This file can’t be attached. Only text files can be used as context.'
const MAIN_UNAVAILABLE_MESSAGE = 'This file is no longer available.'
const MAIN_RANGE_MESSAGE = 'The selected line range is invalid.'
const MAIN_PREPARE_MESSAGE = 'We couldn’t attach this context.'

export const CONTEXT_ITEM_TOO_LARGE_MESSAGE = MAIN_ITEM_TOO_LARGE_MESSAGE
export const CONTEXT_TOTAL_TOO_LARGE_MESSAGE = MAIN_TOTAL_TOO_LARGE_MESSAGE
export const CONTEXT_TOO_MANY_MESSAGE = MAIN_TOO_MANY_MESSAGE
export const CONTEXT_UNSUPPORTED_MESSAGE = MAIN_UNSUPPORTED_MESSAGE
export const CONTEXT_UNAVAILABLE_MESSAGE = MAIN_UNAVAILABLE_MESSAGE
export const CONTEXT_RANGE_MESSAGE = MAIN_RANGE_MESSAGE
export const CONTEXT_PREPARE_MESSAGE = MAIN_PREPARE_MESSAGE

const KNOWN_OUTCOMES: readonly { readonly kind: ContextErrorKind; readonly mainMessage: string }[] = [
  { kind: 'too-large', mainMessage: MAIN_ITEM_TOO_LARGE_MESSAGE },
  { kind: 'total-too-large', mainMessage: MAIN_TOTAL_TOO_LARGE_MESSAGE },
  { kind: 'too-many', mainMessage: MAIN_TOO_MANY_MESSAGE },
  { kind: 'unsupported', mainMessage: MAIN_UNSUPPORTED_MESSAGE },
  { kind: 'unavailable', mainMessage: MAIN_UNAVAILABLE_MESSAGE },
  { kind: 'invalid-range', mainMessage: MAIN_RANGE_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_PREPARE_MESSAGE }
]

/**
 * Normalizes any thrown context failure to canonical display-safe
 * copy. Only `Error` instances are inspected, and only for containment
 * of a known application message.
 */
export function normalizeContextError(error: unknown, fallback: string = CONTEXT_PREPARE_MESSAGE): NormalizedContextError {
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
