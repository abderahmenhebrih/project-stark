/**
 * Generic extension-activation domain errors (Step 7).
 *
 * Machine-readable codes stay main-side for tests and diagnostics;
 * the renderer only ever sees the mapped safe copy (never paths,
 * manifests, stack traces, or provider internals). The unsupported
 * API name is recorded internally for diagnostics but never sent to
 * the renderer beyond the generic compatibility sentence.
 */

export type ExtensionActivationErrorCode =
  | 'invalid-request'
  | 'not-installed'
  | 'disabled'
  | 'uninstalled'
  | 'invalid-manifest'
  | 'manifest-mismatch'
  | 'unsupported-extension-kind'
  | 'unsupported-api'
  | 'activation-failed'
  | 'deactivation-failed'
  | 'timeout'
  | 'host-unavailable'
  | 'busy'
  | 'trust-required'

/** Safe renderer copies, one per user-meaningful outcome. */
export const EXTENSION_ACTIVATION_PUBLIC_COPY: Record<ExtensionActivationErrorCode, string> = {
  'invalid-request': 'That extension request is not valid.',
  'not-installed': 'That extension is not installed.',
  disabled: 'That extension is disabled.',
  uninstalled: 'That extension is not installed.',
  'invalid-manifest': 'That extension could not be activated.',
  'manifest-mismatch': 'That extension could not be activated.',
  'unsupported-extension-kind': 'This extension is not supported in STARK yet.',
  'unsupported-api': 'This extension requires a VS Code API that STARK does not support yet.',
  'activation-failed': 'That extension could not be activated.',
  'deactivation-failed': 'That extension could not be deactivated.',
  timeout: 'That extension timed out. No changes were made.',
  'host-unavailable': 'The Extension Host is unavailable.',
  busy: 'That extension is already working. Try again in a moment.',
  'trust-required': 'That extension needs permission before it can run.'
}

export class ExtensionActivationError extends Error {
  override readonly name: string = 'ExtensionActivationError'
  readonly code: ExtensionActivationErrorCode
  /** Exact unsupported VS Code API for main-side diagnostics only (never renderer copy). */
  readonly unsupportedApi?: string

  constructor(code: ExtensionActivationErrorCode, message?: string, options?: { cause?: unknown; unsupportedApi?: string }) {
    super(message ?? EXTENSION_ACTIVATION_PUBLIC_COPY[code], options === undefined ? undefined : { cause: options.cause })
    this.code = code
    if (options?.unsupportedApi !== undefined) {
      this.unsupportedApi = options.unsupportedApi
    }
  }
}

/** Invalid activation payloads fail validation before any work starts. */
export class InvalidExtensionActivationRequestError extends ExtensionActivationError {
  override readonly name = 'InvalidExtensionActivationRequestError'

  constructor() {
    super('invalid-request')
  }
}

/**
 * Maps any activation-layer failure to a renderer-safe Error carrying
 * displayable copy only. Unknown values collapse to the generic
 * failure copy — never internals, never paths, never API names.
 */
export function toPublicExtensionActivationError(error: unknown): Error {
  if (error instanceof InvalidExtensionActivationRequestError) {
    return new Error(EXTENSION_ACTIVATION_PUBLIC_COPY['invalid-request'])
  }
  if (error instanceof ExtensionActivationError) {
    return new Error(EXTENSION_ACTIVATION_PUBLIC_COPY[error.code])
  }
  return new Error(EXTENSION_ACTIVATION_PUBLIC_COPY['activation-failed'])
}

/**
 * Extracts the exact unsupported API name from a host-side
 * `Unsupported VS Code API: <name>` message for diagnostics.
 * Returns null when the message is not an unsupported-API report.
 */
export function unsupportedApiNameFromMessage(message: string): string | null {
  const prefix = 'Unsupported VS Code API: '
  if (!message.startsWith(prefix)) {
    return null
  }
  const name = message.slice(prefix.length).trim().slice(0, 256)
  return name === '' ? null : name
}
