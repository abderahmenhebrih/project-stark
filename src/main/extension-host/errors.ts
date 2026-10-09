/**
 * Extension-host domain errors (foundation only).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain PIDs, paths, environment contents,
 * credentials, or stack traces. Internal causes stay in main-process
 * diagnostics only.
 */

export class ExtensionHostError extends Error {
  override readonly name: string = 'ExtensionHostError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Host control payload failed runtime validation. */
export class InvalidExtensionHostRequestError extends ExtensionHostError {
  override readonly name = 'InvalidExtensionHostRequestError'

  constructor() {
    super('That extension host request is not valid.')
  }
}

/**
 * Maps any host-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicExtensionHostError(error: unknown): Error {
  if (error instanceof InvalidExtensionHostRequestError) {
    return new Error('That extension host request is not valid.')
  }
  if (error instanceof ExtensionHostError) {
    return new Error('The Extension Host is unavailable.')
  }
  return new Error('The Extension Host is unavailable.')
}
