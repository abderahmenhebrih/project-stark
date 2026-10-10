/**
 * Extension-install domain errors (store only, never execute).
 *
 * Each failure carries a normalized machine-readable code for main-side
 * tests and logging; the renderer only ever sees the mapped safe copy
 * below (never URLs, paths, hashes, status codes, response bodies, or
 * stack traces). Internal causes stay in main-process diagnostics only.
 */

/** Normalized install failure codes (main-side only, never rendered raw). */
export type ExtensionInstallErrorCode =
  | 'network_error'
  | 'timeout'
  | 'package_too_large'
  | 'invalid_download_source'
  | 'invalid_archive'
  | 'manifest_mismatch'
  | 'storage_error'

/** Safe renderer copy for oversized packages (names the standing 50 MiB policy). */
export const PACKAGE_TOO_LARGE_COPY = 'Extension package exceeds STARK’s 50 MiB safety limit.'

/** Safe generic renderer copy for every other install failure. */
export const GENERIC_INSTALL_COPY = 'We couldn’t install this extension.'

/** Safe renderer copy for malformed install references. */
export const INVALID_INSTALL_REFERENCE_COPY = 'That extension reference is not valid.'

export class ExtensionInstallError extends Error {
  override readonly name: string = 'ExtensionInstallError'
  readonly code: ExtensionInstallErrorCode

  constructor(
    message = GENERIC_INSTALL_COPY,
    options?: { cause?: unknown; code?: ExtensionInstallErrorCode }
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause })
    this.code = options?.code ?? 'network_error'
  }
}

/** Install identity payload failed runtime validation. */
export class InvalidExtensionInstallRequestError extends ExtensionInstallError {
  override readonly name = 'InvalidExtensionInstallRequestError'

  constructor() {
    super(INVALID_INSTALL_REFERENCE_COPY)
  }
}

/**
 * Maps any install-layer failure to a renderer-safe Error carrying
 * displayable copy only. Oversized packages name the standing policy
 * so the UI can report a specific reason; identity problems name the
 * bound; every network/archive/manifest/commit failure surfaces one
 * calm message. The machine-readable code stays main-side.
 */
export function toPublicExtensionInstallError(error: unknown): Error {
  if (error instanceof InvalidExtensionInstallRequestError) {
    return new Error(INVALID_INSTALL_REFERENCE_COPY)
  }
  if (error instanceof ExtensionInstallError) {
    if (error.code === 'package_too_large') {
      return new Error(PACKAGE_TOO_LARGE_COPY)
    }
    return new Error(GENERIC_INSTALL_COPY)
  }
  return new Error(GENERIC_INSTALL_COPY)
}
