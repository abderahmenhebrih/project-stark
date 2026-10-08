/**
 * Heart domain errors (Stage 19).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain credentials, endpoints, SQL, IPC
 * channel names, or stack traces.
 */

export class HeartError extends Error {
  override readonly name: string = 'HeartError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A Heart request payload failed runtime validation. */
export class InvalidHeartRequestError extends HeartError {
  override readonly name = 'InvalidHeartRequestError'
}

/** Heart has never been configured and no legacy model exists. */
export class HeartUnconfiguredError extends HeartError {
  override readonly name = 'HeartUnconfiguredError'

  constructor() {
    super('Heart is not configured yet. Save a Brain and Worker model first.')
  }
}

/** The stored Heart configuration fails validation at load time. */
export class InvalidHeartConfigError extends HeartError {
  override readonly name = 'InvalidHeartConfigError'

  constructor() {
    super('The saved Heart configuration is invalid.')
  }
}

/** No Heart assignment covers the requested Worker profile. */
export class HeartRouteMissingError extends HeartError {
  override readonly name = 'HeartRouteMissingError'

  constructor() {
    super('No Worker model is configured for the requested profile.')
  }
}

/** The configured provider is not installed/known. */
export class HeartProviderUnavailableError extends HeartError {
  override readonly name = 'HeartProviderUnavailableError'

  constructor() {
    super('The configured Heart provider is not available.')
  }
}

export type HeartOperation = 'get' | 'update' | 'route'

function genericFor(operation: HeartOperation): string {
  switch (operation) {
    case 'get':
      return 'We couldn’t load the Heart configuration.'
    case 'update':
      return 'We couldn’t save the Heart configuration.'
    case 'route':
      return 'We couldn’t resolve the model route.'
  }
}

/**
 * Maps any Heart-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicHeartError(operation: HeartOperation, error: unknown): Error {
  if (
    error instanceof HeartUnconfiguredError ||
    error instanceof InvalidHeartConfigError ||
    error instanceof HeartRouteMissingError ||
    error instanceof HeartProviderUnavailableError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidHeartRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof HeartError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
