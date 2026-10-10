/**
 * Renderer-side error boundary for document-format operations.
 *
 * Same principle as the change-transaction boundary: Electron wraps
 * every `ipcRenderer.invoke` rejection in transport wording, so raw
 * `Error.message` must never reach the UI. Only the known stable
 * application messages produced by the main-process formatter
 * mapping are recognized; anything unrecognized collapses to the
 * generic message.
 */

export type FormatterErrorKind =
  | 'invalid-request'
  | 'not-installed'
  | 'disabled'
  | 'unsupported-language'
  | 'busy'
  | 'timeout'
  | 'generic'

export interface NormalizedFormatterError {
  readonly kind: FormatterErrorKind
  readonly message: string
}

/** Stable main-process public messages for format operations. */
const MAIN_INVALID_MESSAGE = 'That format request is not valid.'
const MAIN_NOT_INSTALLED_MESSAGE = 'Install Prettier from Extensions to format this document.'
const MAIN_DISABLED_MESSAGE = 'Prettier is disabled.'
const MAIN_UNSUPPORTED_MESSAGE = 'No formatter is available for this file.'
const MAIN_BUSY_MESSAGE = 'Formatting is already running for this file.'
const MAIN_TIMEOUT_MESSAGE = 'Formatting timed out. No changes were made.'
const MAIN_GENERIC_MESSAGE = 'Formatting failed. No changes were made.'

export const FORMAT_INVALID_MESSAGE = MAIN_INVALID_MESSAGE
export const FORMAT_NOT_INSTALLED_MESSAGE = MAIN_NOT_INSTALLED_MESSAGE
export const FORMAT_DISABLED_MESSAGE = MAIN_DISABLED_MESSAGE
export const FORMAT_UNSUPPORTED_MESSAGE = MAIN_UNSUPPORTED_MESSAGE
export const FORMAT_BUSY_MESSAGE = MAIN_BUSY_MESSAGE
export const FORMAT_TIMEOUT_MESSAGE = MAIN_TIMEOUT_MESSAGE
export const FORMAT_GENERIC_MESSAGE = MAIN_GENERIC_MESSAGE

const KNOWN_OUTCOMES: readonly {
  readonly kind: FormatterErrorKind
  readonly mainMessage: string
  readonly message: string
}[] = [
  { kind: 'invalid-request', mainMessage: MAIN_INVALID_MESSAGE, message: FORMAT_INVALID_MESSAGE },
  { kind: 'not-installed', mainMessage: MAIN_NOT_INSTALLED_MESSAGE, message: FORMAT_NOT_INSTALLED_MESSAGE },
  { kind: 'disabled', mainMessage: MAIN_DISABLED_MESSAGE, message: FORMAT_DISABLED_MESSAGE },
  { kind: 'unsupported-language', mainMessage: MAIN_UNSUPPORTED_MESSAGE, message: FORMAT_UNSUPPORTED_MESSAGE },
  { kind: 'busy', mainMessage: MAIN_BUSY_MESSAGE, message: FORMAT_BUSY_MESSAGE },
  { kind: 'timeout', mainMessage: MAIN_TIMEOUT_MESSAGE, message: FORMAT_TIMEOUT_MESSAGE },
  { kind: 'generic', mainMessage: MAIN_GENERIC_MESSAGE, message: FORMAT_GENERIC_MESSAGE }
]

/**
 * Normalizes any thrown format failure to canonical display-safe
 * copy. Only `Error` instances are inspected, and only for
 * containment of a known application message.
 */
export function normalizeFormatterError(error: unknown): NormalizedFormatterError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.mainMessage)) {
        return { kind: outcome.kind, message: outcome.message }
      }
    }
  }
  return { kind: 'generic', message: FORMAT_GENERIC_MESSAGE }
}
