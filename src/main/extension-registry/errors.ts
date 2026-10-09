/**
 * Extension-catalog domain errors (display only).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain URLs, status codes, response
 * bodies, or stack traces. Internal causes stay in main-process
 * diagnostics only.
 */

export class ExtensionRegistryError extends Error {
  override readonly name: string = 'ExtensionRegistryError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Catalog request payload failed runtime validation. */
export class InvalidExtensionRegistryRequestError extends ExtensionRegistryError {
  override readonly name = 'InvalidExtensionRegistryRequestError'

  constructor() {
    super('Search text must be 1–100 characters.')
  }
}

/**
 * Maps any catalog-layer failure to a renderer-safe Error carrying
 * displayable copy only. Network failures, non-OK statuses, timeouts,
 * and malformed payloads all surface the same calm message; invalid
 * requests name the query bound.
 */
export function toPublicExtensionRegistryError(error: unknown): Error {
  if (error instanceof InvalidExtensionRegistryRequestError) {
    return new Error('Search text must be 1–100 characters.')
  }
  if (error instanceof ExtensionRegistryError) {
    return new Error('We couldn’t load extensions.')
  }
  return new Error('We couldn’t load extensions.')
}
