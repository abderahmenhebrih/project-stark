/**
 * Looplink domain errors (Stage 20).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain message content, file contents,
 * absolute paths, SQL, IPC channel names, hashes, or stack traces.
 */

export class LooplinkError extends Error {
  override readonly name: string = 'LooplinkError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A Looplink request payload failed runtime validation. */
export class InvalidLooplinkRequestError extends LooplinkError {
  override readonly name = 'InvalidLooplinkRequestError'
}

/** The source session holds no user work to continue. */
export class LooplinkNoUserWorkError extends LooplinkError {
  override readonly name = 'LooplinkNoUserWorkError'

  constructor() {
    super('There is no user work in this session to continue.')
  }
}

/** Even the mandatory minimum snapshot exceeds the byte budget. */
export class LooplinkPayloadTooLargeError extends LooplinkError {
  override readonly name = 'LooplinkPayloadTooLargeError'

  constructor() {
    super('The continuity snapshot is too large to prepare.')
  }
}

/** No pending handoff exists for the requested session. */
export class LooplinkNotPendingError extends LooplinkError {
  override readonly name = 'LooplinkNotPendingError'

  constructor() {
    super('There is no pending continuity for this session.')
  }
}

/** The persisted payload failed integrity verification. */
export class LooplinkIntegrityError extends LooplinkError {
  override readonly name = 'LooplinkIntegrityError'

  constructor() {
    super('STARK could not verify this Looplink.')
  }
}

/** The source session is busy with an AI operation. */
export class LooplinkSourceBusyError extends LooplinkError {
  override readonly name = 'LooplinkSourceBusyError'

  constructor() {
    super('STARK is still working in this session. Try again after it finishes.')
  }
}

export type LooplinkOperation = 'create' | 'get' | 'dismiss'

function genericFor(operation: LooplinkOperation): string {
  switch (operation) {
    case 'create':
      return 'We couldn’t prepare this continuity.'
    case 'get':
      return 'We couldn’t load this continuity.'
    case 'dismiss':
      return 'We couldn’t dismiss this continuity.'
  }
}

/**
 * Maps any Looplink-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicLooplinkError(operation: LooplinkOperation, error: unknown): Error {
  if (
    error instanceof LooplinkNoUserWorkError ||
    error instanceof LooplinkPayloadTooLargeError ||
    error instanceof LooplinkNotPendingError ||
    error instanceof LooplinkIntegrityError ||
    error instanceof LooplinkSourceBusyError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidLooplinkRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof LooplinkError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
