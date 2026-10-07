/**
 * Terminal domain errors (Stage 11).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain paths, PIDs, environment values,
 * or stack traces. Internal causes stay in main-process diagnostics.
 */

export class TerminalError extends Error {
  override readonly name: string = 'TerminalError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Request payload failed runtime validation. */
export class InvalidTerminalRequestError extends TerminalError {
  override readonly name = 'InvalidTerminalRequestError'
}

/** No session exists for the requested ID. */
export class TerminalNotFoundError extends TerminalError {
  override readonly name = 'TerminalNotFoundError'

  constructor() {
    super('That terminal session is no longer available.')
  }
}

/** The caller does not own the requested session. */
export class TerminalOwnershipError extends TerminalError {
  override readonly name = 'TerminalOwnershipError'

  constructor() {
    super('That terminal session is no longer available.')
  }
}

/** The workspace root is gone or inaccessible. */
export class TerminalWorkspaceUnavailableError extends TerminalError {
  override readonly name = 'TerminalWorkspaceUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('That project folder is no longer available.', options)
  }
}

/** The shell could not start or the PTY backend is unavailable. */
export class TerminalUnavailableError extends TerminalError {
  override readonly name = 'TerminalUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t start the terminal.', options)
  }
}

export type TerminalOperation = 'create' | 'write' | 'resize' | 'kill'

/**
 * Maps any terminal-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicTerminalError(operation: TerminalOperation, error: unknown): Error {
  if (error instanceof TerminalWorkspaceUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof TerminalNotFoundError || error instanceof TerminalOwnershipError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidTerminalRequestError) {
    if (operation === 'write' || operation === 'resize') {
      return new Error('That terminal input was not accepted.')
    }
    if (operation === 'kill') {
      return new Error('That terminal session is no longer available.')
    }
    return new Error('We couldn’t start the terminal.')
  }
  if (error instanceof TerminalUnavailableError) {
    return new Error(error.message)
  }
  if (operation === 'write' || operation === 'resize') {
    return new Error('That terminal input was not accepted.')
  }
  if (operation === 'kill') {
    return new Error('That terminal session is no longer available.')
  }
  return new Error('We couldn’t start the terminal.')
}
