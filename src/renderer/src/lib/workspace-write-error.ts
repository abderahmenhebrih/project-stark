/**
 * Renderer-side error boundary for Workspace file writes.
 *
 * Electron wraps every `ipcRenderer.invoke` rejection in transport
 * wording ("Error invoking remote method '…': …"), so raw
 * `Error.message` must never reach the UI. This module maps a thrown
 * value to a small closed set of canonical, display-safe outcomes by
 * recognizing ONLY the known stable application messages produced by
 * the main-process `toPublicError('write-text-file', …)` mapping.
 * Channel names, prefixes, and anything unrecognized are never
 * inspected for meaning and never surfaced: unknown failures collapse
 * to the generic message.
 */

export type WorkspaceWriteErrorKind =
  | 'conflict'
  | 'too-large'
  | 'unsupported-text'
  | 'unavailable'
  | 'generic'

export interface NormalizedWorkspaceWriteError {
  readonly kind: WorkspaceWriteErrorKind
  readonly message: string
}

/** Stable main-process public messages for the write-text-file operation. */
const MAIN_CONFLICT_MESSAGE = 'This file changed on disk. Reload it before saving your changes.'
const MAIN_TOO_LARGE_MESSAGE = 'This file is too large to save.'
const MAIN_UNSUPPORTED_MESSAGE = 'This file isn’t a supported text file.'
const MAIN_UNAVAILABLE_MESSAGE = 'We couldn’t save this file.'

export const WRITE_CONFLICT_MESSAGE = MAIN_CONFLICT_MESSAGE
export const WRITE_TOO_LARGE_MESSAGE = 'This file is too large to save with the current editor.'
export const WRITE_UNSUPPORTED_MESSAGE = MAIN_UNSUPPORTED_MESSAGE
export const WRITE_GENERIC_MESSAGE = MAIN_UNAVAILABLE_MESSAGE

const KNOWN_OUTCOMES: readonly {
  readonly kind: WorkspaceWriteErrorKind
  readonly mainMessage: string
  readonly message: string
}[] = [
  { kind: 'conflict', mainMessage: MAIN_CONFLICT_MESSAGE, message: WRITE_CONFLICT_MESSAGE },
  { kind: 'too-large', mainMessage: MAIN_TOO_LARGE_MESSAGE, message: WRITE_TOO_LARGE_MESSAGE },
  { kind: 'unsupported-text', mainMessage: MAIN_UNSUPPORTED_MESSAGE, message: WRITE_UNSUPPORTED_MESSAGE },
  { kind: 'unavailable', mainMessage: MAIN_UNAVAILABLE_MESSAGE, message: WRITE_GENERIC_MESSAGE }
]

/**
 * Normalizes any thrown write failure to canonical display-safe copy.
 * Only `Error` instances are inspected, and only for containment of a
 * known application message — transport prefixes around it are ignored
 * without being parsed or trusted. Anything else (unknown errors,
 * non-Errors, missing messages) becomes the generic outcome, and the
 * returned message is always one of the constants above.
 */
export function normalizeWorkspaceWriteError(error: unknown): NormalizedWorkspaceWriteError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.message }
      }
    }
  }
  return { kind: 'generic', message: WRITE_GENERIC_MESSAGE }
}
