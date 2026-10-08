/**
 * Capability domain errors (Stage 22).
 *
 * Public messages are stable user-facing copy for config operations.
 * Authorization denial is normally a decision, not an exception.
 * Never contains SQL, paths, IPC channels, or stack traces.
 */

export class CapabilityError extends Error {
  override readonly name: string = 'CapabilityError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A capability config payload failed validation. */
export class InvalidCapabilityConfigError extends CapabilityError {
  override readonly name = 'InvalidCapabilityConfigError'

  constructor() {
    super('The workspace permissions are invalid.')
  }
}

/** The referenced workspace does not exist. */
export class CapabilityWorkspaceNotFoundError extends CapabilityError {
  override readonly name = 'CapabilityWorkspaceNotFoundError'

  constructor() {
    super('The workspace was not found.')
  }
}

/** A capability request payload failed runtime validation. */
export class InvalidCapabilityRequestError extends CapabilityError {
  override readonly name = 'InvalidCapabilityRequestError'
}

export type CapabilityOperation = 'get' | 'update'

function genericFor(operation: CapabilityOperation): string {
  switch (operation) {
    case 'get':
      return 'We couldn’t load the workspace permissions.'
    case 'update':
      return 'We couldn’t save the workspace permissions.'
  }
}

/** Safe public categories for config failures (no internals). */
export type CapabilityPublicCategory =
  | 'capability-invalid-config'
  | 'capability-workspace-not-found'
  | 'capability-save-failed'

/**
 * Maps any capability-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicCapabilityError(operation: CapabilityOperation, error: unknown): Error {
  if (
    error instanceof InvalidCapabilityConfigError ||
    error instanceof CapabilityWorkspaceNotFoundError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidCapabilityRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof CapabilityError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
