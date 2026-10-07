import { DatabaseError } from '../database/errors'

/**
 * Settings domain errors.
 *
 * Messages identify the failed operation and the offending field or
 * expectation — never stored values, payloads, or database internals.
 * Internal causes are preserved for main-process diagnostics only.
 */

export class SettingsError extends Error {
  override readonly name: string = 'SettingsError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A settings update payload failed runtime validation. */
export class InvalidSettingsError extends SettingsError {
  override readonly name = 'InvalidSettingsError'
}

/** Persisted settings exist but cannot be validated. Never logs the payload. */
export class CorruptSettingsError extends SettingsError {
  override readonly name = 'CorruptSettingsError'

  constructor(options?: { cause?: unknown }) {
    super('stored settings are invalid', options)
  }
}

export type SettingsOperation = 'get' | 'update' | 'reset'

/**
 * Maps any service-layer failure to a renderer-safe Error.
 * No database internals, stored values, or stack traces cross IPC —
 * only a stable, operation-identifying message.
 */
export function toPublicError(operation: SettingsOperation, error: unknown): Error {
  if (error instanceof InvalidSettingsError) {
    return new Error(`stark settings ${operation} failed: ${error.message}`)
  }
  if (error instanceof CorruptSettingsError) {
    return new Error(`stark settings ${operation} failed: stored settings are invalid`)
  }
  if (error instanceof DatabaseError) {
    return new Error(`stark settings ${operation} failed: storage unavailable`)
  }
  return new Error(`stark settings ${operation} failed`)
}
