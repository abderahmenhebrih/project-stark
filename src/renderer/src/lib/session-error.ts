/**
 * Renderer-side error boundary for coding-session operations.
 *
 * Same principle as the change-transaction boundary: Electron wraps
 * every `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process session mapping
 * are recognized; channel names, prefixes, database wording, and
 * anything unrecognized collapse to the caller-supplied fallback.
 */

export type SessionErrorKind = 'too-large' | 'invalid' | 'not-found' | 'workspace-gone' | 'generic'

export interface NormalizedSessionError {
  readonly kind: SessionErrorKind
  readonly message: string
}

/** Stable main-process public messages for session operations. */
const MAIN_TOO_LARGE_MESSAGE = 'This message is too large.'
const MAIN_SAVE_MESSAGE = 'We couldn’t save this message.'
const MAIN_NOT_FOUND_MESSAGE = 'That session is no longer available.'
const MAIN_WORKSPACE_GONE_MESSAGE = 'That project folder is no longer available.'
const MAIN_CREATE_MESSAGE = 'We couldn’t create this session.'
const MAIN_LIST_MESSAGE = 'We couldn’t load your sessions.'
const MAIN_MESSAGES_MESSAGE = 'We couldn’t load these messages.'

export const SESSION_TOO_LARGE_MESSAGE = MAIN_TOO_LARGE_MESSAGE
export const SESSION_SAVE_MESSAGE = MAIN_SAVE_MESSAGE
export const SESSION_NOT_FOUND_MESSAGE = MAIN_NOT_FOUND_MESSAGE
export const SESSION_WORKSPACE_GONE_MESSAGE = MAIN_WORKSPACE_GONE_MESSAGE
export const SESSION_CREATE_MESSAGE = MAIN_CREATE_MESSAGE
export const SESSION_LIST_MESSAGE = MAIN_LIST_MESSAGE
export const SESSION_MESSAGES_MESSAGE = MAIN_MESSAGES_MESSAGE

const KNOWN_OUTCOMES: readonly { readonly kind: SessionErrorKind; readonly mainMessage: string }[] = [
  { kind: 'too-large', mainMessage: MAIN_TOO_LARGE_MESSAGE },
  { kind: 'invalid', mainMessage: MAIN_SAVE_MESSAGE },
  { kind: 'not-found', mainMessage: MAIN_NOT_FOUND_MESSAGE },
  { kind: 'workspace-gone', mainMessage: MAIN_WORKSPACE_GONE_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_CREATE_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_LIST_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_MESSAGES_MESSAGE }
]

/**
 * Normalizes any thrown session failure to canonical display-safe
 * copy. Only `Error` instances are inspected, and only for containment
 * of a known application message. Anything else collapses to the
 * caller-supplied fallback (a safe composer/list copy chosen by the
 * calling view).
 */
export function normalizeSessionError(error: unknown, fallback: string = SESSION_SAVE_MESSAGE): NormalizedSessionError {
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
