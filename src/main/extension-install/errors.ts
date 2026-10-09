/**
 * Extension-install domain errors (store only, never execute).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain URLs, paths, hashes, status codes,
 * response bodies, or stack traces. Internal causes stay in
 * main-process diagnostics only.
 */

export class ExtensionInstallError extends Error {
  override readonly name: string = 'ExtensionInstallError'

  constructor(message = 'We couldn’t install this extension.', options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Install identity payload failed runtime validation. */
export class InvalidExtensionInstallRequestError extends ExtensionInstallError {
  override readonly name = 'InvalidExtensionInstallRequestError'

  constructor() {
    super('That extension reference is not valid.')
  }
}

/**
 * Maps any install-layer failure to a renderer-safe Error carrying
 * displayable copy only. Identity problems name the bound; every
 * network/archive/manifest/commit failure surfaces one calm message.
 */
export function toPublicExtensionInstallError(error: unknown): Error {
  if (error instanceof InvalidExtensionInstallRequestError) {
    return new Error('That extension reference is not valid.')
  }
  if (error instanceof ExtensionInstallError) {
    return new Error('We couldn’t install this extension.')
  }
  return new Error('We couldn’t install this extension.')
}
