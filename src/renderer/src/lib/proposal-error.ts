/**
 * Renderer-side error boundary for Stage 16 code proposals.
 *
 * Same principle as the other boundaries: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process proposal mapping
 * (plus the shared provider mapping for credential/network states)
 * are recognized; anything unrecognized collapses to the
 * caller-supplied fallback.
 */

export type ProposalErrorKind =
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

export interface NormalizedProposalError {
  readonly kind: ProposalErrorKind
  readonly message: string
}

/** Stable main-process public messages for proposal operations. */
const MAIN_MISSING_CONTEXT = 'Attach exactly one whole file to propose a code change.'
const MAIN_NOTHING_TO_PROPOSE = 'There is no new message to propose a change for.'
const MAIN_STALE_BEFORE = 'This file changed after you attached it. Attach it again before requesting a change.'
const MAIN_STALE_DURING = 'The file changed while STARK was preparing the proposal. Attach it again and try again.'
const MAIN_NO_CHANGES = 'STARK did not propose any code changes.'
const MAIN_INVALID_OUTPUT = 'STARK could not create a valid code proposal.'
const MAIN_TOO_LARGE = 'The proposed change is too large.'
const MAIN_STRUCTURED_UNSUPPORTED =
  'The selected model could not create a structured code proposal. Choose another model.'
const MAIN_IN_FLIGHT = 'STARK is already generating a response for this session.'
const MAIN_GENERIC = 'We couldn’t prepare this code proposal.'

export const PROPOSAL_MISSING_CONTEXT_MESSAGE = MAIN_MISSING_CONTEXT
export const PROPOSAL_NOTHING_TO_PROPOSE_MESSAGE = MAIN_NOTHING_TO_PROPOSE
export const PROPOSAL_STALE_BEFORE_MESSAGE = MAIN_STALE_BEFORE
export const PROPOSAL_STALE_DURING_MESSAGE = MAIN_STALE_DURING
export const PROPOSAL_NO_CHANGES_MESSAGE = MAIN_NO_CHANGES
export const PROPOSAL_INVALID_OUTPUT_MESSAGE = MAIN_INVALID_OUTPUT
export const PROPOSAL_TOO_LARGE_MESSAGE = MAIN_TOO_LARGE
export const PROPOSAL_STRUCTURED_UNSUPPORTED_MESSAGE = MAIN_STRUCTURED_UNSUPPORTED
export const PROPOSAL_IN_FLIGHT_MESSAGE = MAIN_IN_FLIGHT
export const PROPOSAL_GENERIC_MESSAGE = MAIN_GENERIC

const KNOWN_OUTCOMES: readonly { readonly kind: ProposalErrorKind; readonly mainMessage: string }[] = [
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
 * Normalizes any thrown proposal failure to canonical display-safe
 * copy. Only `Error` instances are inspected, and only for containment
 * of a known application message.
 */
export function normalizeProposalError(
  error: unknown,
  fallback: string = PROPOSAL_GENERIC_MESSAGE
): NormalizedProposalError {
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
