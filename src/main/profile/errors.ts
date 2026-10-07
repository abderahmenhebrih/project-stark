import { DatabaseError } from '../database/errors'

/**
 * Profile domain errors.
 *
 * Messages identify the failed operation — never stored values, payloads,
 * database internals, or filesystem paths. Internal causes are preserved
 * for main-process diagnostics only.
 */

export class ProfileError extends Error {
  override readonly name: string = 'ProfileError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A display-name payload failed runtime validation. */
export class InvalidDisplayNameError extends ProfileError {
  override readonly name = 'InvalidDisplayNameError'
}

/** Persisted profile data exists but cannot be validated. Never logs the payload. */
export class CorruptProfileError extends ProfileError {
  override readonly name = 'CorruptProfileError'

  constructor(options?: { cause?: unknown }) {
    super('stored profile is invalid', options)
  }
}

export type ProfileOperation = 'get' | 'set-display-name'

/**
 * Maps any service-layer failure to a renderer-safe Error.
 * No database internals, stored values, or stack traces cross IPC —
 * only a stable, operation-identifying message.
 */
export function toPublicError(operation: ProfileOperation, error: unknown): Error {
  if (error instanceof InvalidDisplayNameError) {
    return new Error(`stark profile ${operation} failed: ${error.message}`)
  }
  if (error instanceof CorruptProfileError) {
    return new Error(`stark profile ${operation} failed: stored profile is invalid`)
  }
  if (error instanceof DatabaseError) {
    return new Error(`stark profile ${operation} failed: storage unavailable`)
  }
  return new Error(`stark profile ${operation} failed`)
}
