/**
 * Explicit project-context errors (Stage 15).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain file contents, absolute paths,
 * SQL, IPC channel names, or stack traces. Relative paths shown in UI
 * come from validated labels, never from error text.
 */

export class SessionContextError extends Error {
  override readonly name: string = 'SessionContextError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A context request payload failed runtime validation. */
export class InvalidContextRequestError extends SessionContextError {
  override readonly name = 'InvalidContextRequestError'
}

/** One context item exceeds the per-item byte bound. */
export class ContextItemTooLargeError extends SessionContextError {
  override readonly name = 'ContextItemTooLargeError'

  constructor() {
    super('This context item is too large to attach.')
  }
}

/** The combined attached context exceeds the total byte bound. */
export class TotalContextTooLargeError extends SessionContextError {
  override readonly name = 'TotalContextTooLargeError'

  constructor() {
    super('The total attached context is too large.')
  }
}

/** More than MAX_CONTEXT_ITEMS were attached to one message. */
export class TooManyContextItemsError extends SessionContextError {
  override readonly name = 'TooManyContextItemsError'

  constructor() {
    super('You can attach at most 20 context items to one message.')
  }
}

/** The file is binary or otherwise not attachable text. */
export class UnsupportedContextFileError extends SessionContextError {
  override readonly name = 'UnsupportedContextFileError'

  constructor(options?: { cause?: unknown }) {
    super('This file can’t be attached. Only text files can be used as context.', options)
  }
}

/** The file disappeared or cannot be read anymore. */
export class ContextFileUnavailableError extends SessionContextError {
  override readonly name = 'ContextFileUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('This file is no longer available.', options)
  }
}

/** The requested line range is invalid for the file. */
export class InvalidContextRangeError extends SessionContextError {
  override readonly name = 'InvalidContextRangeError'

  constructor() {
    super('The selected line range is invalid.')
  }
}

/** Stable copy for a file that changed after the user reviewed it. */
export const STALE_CONTEXT_MESSAGE = 'This attached context changed on disk. Reattach it before sending.'

/**
 * A file-backed attachment went stale between prepare and send: the
 * on-disk revision no longer equals the reviewed `sourceRevision`.
 * The send must fail atomically — no persistence, no provider call —
 * and the user must reattach explicitly. Never auto-refresh.
 */
export class StaleContextError extends SessionContextError {
  override readonly name = 'StaleContextError'

  constructor(options?: { cause?: unknown }) {
    super(STALE_CONTEXT_MESSAGE, options)
  }
}

export type ContextOperation = 'prepare' | 'send'

/**
 * Maps any context-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicContextError(operation: ContextOperation, error: unknown): Error {
  if (
    error instanceof ContextItemTooLargeError ||
    error instanceof TotalContextTooLargeError ||
    error instanceof TooManyContextItemsError ||
    error instanceof UnsupportedContextFileError ||
    error instanceof ContextFileUnavailableError ||
    error instanceof InvalidContextRangeError ||
    error instanceof StaleContextError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidContextRequestError) {
    return new Error(
      operation === 'prepare' ? 'We couldn’t attach this context.' : 'We couldn’t save this message.'
    )
  }
  if (error instanceof SessionContextError) {
    return new Error(
      operation === 'prepare' ? 'We couldn’t attach this context.' : 'We couldn’t save this message.'
    )
  }
  return new Error(
    operation === 'prepare' ? 'We couldn’t attach this context.' : 'We couldn’t save this message.'
  )
}
