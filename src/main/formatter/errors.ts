/**
 * Document-formatter domain errors (Prettier pilot).
 *
 * Failures carry a normalized machine-readable code for main-side
 * tests; the renderer only ever sees the mapped safe copy below
 * (never paths, revisions, package details, or stack traces).
 */

/** Normalized formatter failure codes (main-side only). */
export type FormatterErrorCode =
  | 'invalid_request'
  | 'not_installed'
  | 'disabled'
  | 'unsupported_language'
  | 'busy'
  | 'timeout'
  | 'host_unavailable'
  | 'format_failed'

/** Safe renderer copies, one per user-meaningful outcome. */
export const FORMATTER_PUBLIC_COPY: Record<FormatterErrorCode, string> = {
  invalid_request: 'That format request is not valid.',
  not_installed: 'Install Prettier from Extensions to format this document.',
  disabled: 'Prettier is disabled.',
  unsupported_language: 'No formatter is available for this file.',
  busy: 'Formatting is already running for this file.',
  timeout: 'Formatting timed out. No changes were made.',
  host_unavailable: 'Formatting failed. No changes were made.',
  format_failed: 'Formatting failed. No changes were made.'
}

export class FormatterError extends Error {
  override readonly name: string = 'FormatterError'
  readonly code: FormatterErrorCode

  constructor(code: FormatterErrorCode, options?: { cause?: unknown }) {
    super(FORMATTER_PUBLIC_COPY[code], options === undefined ? undefined : { cause: options.cause })
    this.code = code
  }
}

/** Invalid format payloads fail validation before any work starts. */
export class InvalidFormatterRequestError extends FormatterError {
  override readonly name = 'InvalidFormatterRequestError'

  constructor() {
    super('invalid_request')
  }
}

/**
 * Maps any formatter-layer failure to a renderer-safe Error carrying
 * displayable copy only. Unknown values collapse to the generic
 * failure copy — never internals.
 */
export function toPublicFormatterError(error: unknown): Error {
  if (error instanceof InvalidFormatterRequestError) {
    return new Error(FORMATTER_PUBLIC_COPY['invalid_request'])
  }
  if (error instanceof FormatterError) {
    return new Error(FORMATTER_PUBLIC_COPY[error.code])
  }
  return new Error(FORMATTER_PUBLIC_COPY['format_failed'])
}
