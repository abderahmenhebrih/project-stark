/**
 * Coding-session domain errors (Stage 13).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain message content, SQL, database
 * paths, IPC channel names, or stack traces. Internal causes stay in
 * main-process diagnostics only.
 */

export class SessionError extends Error {
  override readonly name: string = 'SessionError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A request payload failed runtime validation. */
export class InvalidSessionRequestError extends SessionError {
  override readonly name = 'InvalidSessionRequestError'
}

/** No session exists for the requested ID (or it belongs elsewhere). */
export class SessionNotFoundError extends SessionError {
  override readonly name = 'SessionNotFoundError'

  constructor() {
    super('That session is no longer available.')
  }
}

/**
 * The session belongs to a different workspace than the requested one.
 * Same public copy as not-found so session IDs cannot probe other
 * workspaces.
 */
export class SessionWorkspaceMismatchError extends SessionError {
  override readonly name = 'SessionWorkspaceMismatchError'

  constructor() {
    super('That session is no longer available.')
  }
}

/** The workspace row is gone or inaccessible. */
export class SessionWorkspaceUnavailableError extends SessionError {
  override readonly name = 'SessionWorkspaceUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('That project folder is no longer available.', options)
  }
}

/** User message content failed validation (empty, NUL, controls…). */
export class InvalidSessionMessageError extends SessionError {
  override readonly name = 'InvalidSessionMessageError'

  constructor() {
    super('We couldn’t save this message.')
  }
}

/** User message exceeds the 64 KiB UTF-8 limit. */
export class SessionMessageTooLargeError extends SessionError {
  override readonly name = 'SessionMessageTooLargeError'

  constructor() {
    super('This message is too large.')
  }
}

export type SessionOperation = 'create' | 'list' | 'list-messages' | 'send'

function genericFor(operation: SessionOperation): string {
  switch (operation) {
    case 'create':
      return 'We couldn’t create this session.'
    case 'list':
      return 'We couldn’t load your sessions.'
    case 'list-messages':
      return 'We couldn’t load these messages.'
    case 'send':
      return 'We couldn’t save this message.'
  }
}

/**
 * Maps any session-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicSessionError(operation: SessionOperation, error: unknown): Error {
  if (error instanceof SessionMessageTooLargeError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidSessionMessageError) {
    return new Error(error.message)
  }
  if (error instanceof SessionNotFoundError || error instanceof SessionWorkspaceMismatchError) {
    return new Error(error.message)
  }
  if (error instanceof SessionWorkspaceUnavailableError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidSessionRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof SessionError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
