/**
 * Recovery domain errors (Stage 21).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain credentials, endpoints, SQL, IPC
 * channel names, provider bodies, or stack traces.
 */

export class RecoveryError extends Error {
  override readonly name: string = 'RecoveryError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A recovery request payload failed runtime validation. */
export class InvalidRecoveryRequestError extends RecoveryError {
  override readonly name = 'InvalidRecoveryRequestError'
}

/** A recovery configuration failed validation. */
export class InvalidRecoveryConfigError extends RecoveryError {
  override readonly name = 'InvalidRecoveryConfigError'

  constructor() {
    super('The saved recovery configuration is invalid.')
  }
}

/** Recovery was requested but is not configured for the mode. */
export class RecoveryUnconfiguredError extends RecoveryError {
  override readonly name = 'RecoveryUnconfiguredError'

  constructor() {
    super('Recovery is not configured yet. Save recovery models first.')
  }
}

/** The configured recovery provider is not installed/known. */
export class RecoveryProviderUnavailableError extends RecoveryError {
  override readonly name = 'RecoveryProviderUnavailableError'

  constructor() {
    super('The configured recovery provider is not available.')
  }
}

export type RecoveryOperation = 'get' | 'update' | 'lookup' | 'dismiss' | 'recover'

function genericFor(operation: RecoveryOperation): string {
  switch (operation) {
    case 'get':
      return 'We couldn’t load the recovery configuration.'
    case 'update':
      return 'We couldn’t save the recovery configuration.'
    case 'lookup':
      return 'We couldn’t load the recovery state.'
    case 'dismiss':
      return 'We couldn’t dismiss this recovery.'
    case 'recover':
      return 'We couldn’t continue this request.'
  }
}

/**
 * Maps any recovery-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicRecoveryError(operation: RecoveryOperation, error: unknown): Error {
  if (
    error instanceof RecoveryUnconfiguredError ||
    error instanceof InvalidRecoveryConfigError ||
    error instanceof RecoveryProviderUnavailableError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidRecoveryRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof RecoveryError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
