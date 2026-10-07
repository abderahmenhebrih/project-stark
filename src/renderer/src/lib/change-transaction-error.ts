/**
 * Renderer-side error boundary for change-transaction operations.
 *
 * Same principle as the Stage 8B write boundary: Electron wraps every
 * `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process transaction
 * mapping are recognized; channel names, prefixes, database wording,
 * and anything unrecognized collapse to the generic message.
 */

export type ChangeTransactionErrorKind =
  | 'conflict'
  | 'rollback-conflict'
  | 'too-large'
  | 'unsupported-text'
  | 'invalid-state'
  | 'no-changes'
  | 'corrupt'
  | 'not-found'
  | 'workspace-gone'
  | 'generic'

export interface NormalizedChangeTransactionError {
  readonly kind: ChangeTransactionErrorKind
  readonly message: string
}

/** Stable main-process public messages for transaction operations. */
const MAIN_CONFLICT_MESSAGE = 'This file changed on disk. Reload it before saving your changes.'
const MAIN_ROLLBACK_CONFLICT_MESSAGE = 'This file changed on disk. Reload it before rolling back this change.'
const MAIN_TOO_LARGE_MESSAGE = 'This file is too large to save with the current editor.'
const MAIN_UNSUPPORTED_MESSAGE = 'This file isn’t a supported text file.'
const MAIN_STATE_MESSAGE = 'That change can’t be updated in its current state.'
const MAIN_NO_CHANGES_MESSAGE = 'There are no changes to review.'
const MAIN_CORRUPT_MESSAGE = 'That change’s stored data can’t be used.'
const MAIN_NOT_FOUND_MESSAGE = 'That change is no longer available.'
const MAIN_WORKSPACE_GONE_MESSAGE = 'That project folder is no longer available.'
const MAIN_GENERIC_MESSAGE = 'We couldn’t update this change.'

export const CHANGE_CONFLICT_MESSAGE = MAIN_CONFLICT_MESSAGE
export const CHANGE_ROLLBACK_CONFLICT_MESSAGE = MAIN_ROLLBACK_CONFLICT_MESSAGE
export const CHANGE_TOO_LARGE_MESSAGE = MAIN_TOO_LARGE_MESSAGE
export const CHANGE_UNSUPPORTED_MESSAGE = MAIN_UNSUPPORTED_MESSAGE
export const CHANGE_STATE_MESSAGE = MAIN_STATE_MESSAGE
export const CHANGE_NO_CHANGES_MESSAGE = MAIN_NO_CHANGES_MESSAGE
export const CHANGE_CORRUPT_MESSAGE = MAIN_CORRUPT_MESSAGE
export const CHANGE_NOT_FOUND_MESSAGE = MAIN_NOT_FOUND_MESSAGE
export const CHANGE_WORKSPACE_GONE_MESSAGE = MAIN_WORKSPACE_GONE_MESSAGE
export const CHANGE_GENERIC_MESSAGE = MAIN_GENERIC_MESSAGE

const KNOWN_OUTCOMES: readonly {
  readonly kind: ChangeTransactionErrorKind
  readonly mainMessage: string
  readonly message: string
}[] = [
  { kind: 'rollback-conflict', mainMessage: MAIN_ROLLBACK_CONFLICT_MESSAGE, message: CHANGE_ROLLBACK_CONFLICT_MESSAGE },
  { kind: 'conflict', mainMessage: MAIN_CONFLICT_MESSAGE, message: CHANGE_CONFLICT_MESSAGE },
  { kind: 'too-large', mainMessage: MAIN_TOO_LARGE_MESSAGE, message: CHANGE_TOO_LARGE_MESSAGE },
  { kind: 'unsupported-text', mainMessage: MAIN_UNSUPPORTED_MESSAGE, message: CHANGE_UNSUPPORTED_MESSAGE },
  { kind: 'invalid-state', mainMessage: MAIN_STATE_MESSAGE, message: CHANGE_STATE_MESSAGE },
  { kind: 'no-changes', mainMessage: MAIN_NO_CHANGES_MESSAGE, message: CHANGE_NO_CHANGES_MESSAGE },
  { kind: 'corrupt', mainMessage: MAIN_CORRUPT_MESSAGE, message: CHANGE_CORRUPT_MESSAGE },
  { kind: 'not-found', mainMessage: MAIN_NOT_FOUND_MESSAGE, message: CHANGE_NOT_FOUND_MESSAGE },
  { kind: 'workspace-gone', mainMessage: MAIN_WORKSPACE_GONE_MESSAGE, message: CHANGE_WORKSPACE_GONE_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_GENERIC_MESSAGE, message: CHANGE_GENERIC_MESSAGE }
]

/**
 * Normalizes any thrown transaction failure to canonical display-safe
 * copy. Only `Error` instances are inspected, and only for containment
 * of a known application message. The rollback-conflict entry is
 * ordered before the plain conflict entry because both share a
 * sentence stem; ordering is by full-message match, never by channel.
 */
export function normalizeChangeTransactionError(error: unknown): NormalizedChangeTransactionError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.message }
      }
    }
  }
  return { kind: 'generic', message: CHANGE_GENERIC_MESSAGE }
}
