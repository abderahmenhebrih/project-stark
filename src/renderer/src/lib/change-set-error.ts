/**
 * Renderer-side error boundary for Stage 17 grouped proposals.
 *
 * Same principle as the other boundaries: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process change-set
 * mapping (plus the shared provider mapping for credential/network
 * states) are recognized; anything unrecognized collapses to the
 * caller-supplied fallback.
 */

export type ChangeSetProposalErrorKind =
  | 'missing-context'
  | 'nothing-to-propose'
  | 'stale-before'
  | 'stale-during'
  | 'no-changes'
  | 'invalid-output'
  | 'too-large'
  | 'structured-unsupported'
  | 'in-flight'
  | 'generic'

export interface NormalizedChangeSetProposalError {
  readonly kind: ChangeSetProposalErrorKind
  readonly message: string
}

/** Stable main-process public messages for grouped proposals. */
const MAIN_MISSING_CONTEXT = 'Attach two to five whole files to propose grouped code changes.'
const MAIN_NOTHING_TO_PROPOSE = 'There is no new message to propose changes for.'
const MAIN_STALE_BEFORE =
  'One of the attached files changed after you attached it. Attach the changed files again before requesting a proposal.'
const MAIN_STALE_DURING =
  'One of the files changed while STARK was preparing the proposal. Attach it again and try again.'
const MAIN_NO_CHANGES = 'STARK did not propose any code changes.'
const MAIN_INVALID_OUTPUT = 'STARK could not create a valid grouped code proposal.'
const MAIN_TOO_LARGE = 'The grouped proposed changes are too large.'
const MAIN_STRUCTURED_UNSUPPORTED =
  'The selected model could not create a structured code proposal. Choose another model.'
const MAIN_IN_FLIGHT = 'STARK is already generating a response for this session.'
const MAIN_GENERIC = 'We couldn’t prepare this grouped code proposal.'

export const CHANGE_SET_MISSING_CONTEXT_MESSAGE = MAIN_MISSING_CONTEXT
export const CHANGE_SET_NOTHING_TO_PROPOSE_MESSAGE = MAIN_NOTHING_TO_PROPOSE
export const CHANGE_SET_STALE_BEFORE_MESSAGE = MAIN_STALE_BEFORE
export const CHANGE_SET_STALE_DURING_MESSAGE = MAIN_STALE_DURING
export const CHANGE_SET_NO_CHANGES_MESSAGE = MAIN_NO_CHANGES
export const CHANGE_SET_INVALID_OUTPUT_MESSAGE = MAIN_INVALID_OUTPUT
export const CHANGE_SET_TOO_LARGE_MESSAGE = MAIN_TOO_LARGE
export const CHANGE_SET_STRUCTURED_UNSUPPORTED_MESSAGE = MAIN_STRUCTURED_UNSUPPORTED
export const CHANGE_SET_IN_FLIGHT_MESSAGE = MAIN_IN_FLIGHT
export const CHANGE_SET_GENERIC_MESSAGE = MAIN_GENERIC

const KNOWN_OUTCOMES: readonly { readonly kind: ChangeSetProposalErrorKind; readonly mainMessage: string }[] = [
  { kind: 'missing-context', mainMessage: MAIN_MISSING_CONTEXT },
  { kind: 'nothing-to-propose', mainMessage: MAIN_NOTHING_TO_PROPOSE },
  { kind: 'stale-before', mainMessage: MAIN_STALE_BEFORE },
  { kind: 'stale-during', mainMessage: MAIN_STALE_DURING },
  { kind: 'no-changes', mainMessage: MAIN_NO_CHANGES },
  { kind: 'invalid-output', mainMessage: MAIN_INVALID_OUTPUT },
  { kind: 'too-large', mainMessage: MAIN_TOO_LARGE },
  { kind: 'structured-unsupported', mainMessage: MAIN_STRUCTURED_UNSUPPORTED },
  { kind: 'in-flight', mainMessage: MAIN_IN_FLIGHT },
  { kind: 'generic', mainMessage: MAIN_GENERIC }
]

/**
 * Normalizes any thrown grouped-proposal failure to canonical
 * display-safe copy. Only `Error` instances are inspected, and only
 * for containment of a known application message.
 */
export function normalizeChangeSetProposalError(
  error: unknown,
  fallback: string = CHANGE_SET_GENERIC_MESSAGE
): NormalizedChangeSetProposalError {
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
