/**
 * Change-set domain errors (Stage 17).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain file contents, absolute paths,
 * SQL, IPC channel names, or stack traces.
 */

export class ChangeSetError extends Error {
  override readonly name: string = 'ChangeSetError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A Change Set request payload failed runtime validation. */
export class InvalidChangeSetRequestError extends ChangeSetError {
  override readonly name = 'InvalidChangeSetRequestError'
}

/** No Change Set exists for the requested ID. */
export class ChangeSetNotFoundError extends ChangeSetError {
  override readonly name = 'ChangeSetNotFoundError'

  constructor() {
    super('That change set is no longer available.')
  }
}

export type ChangeSetOperation = 'get' | 'list-recent' | 'create'

function genericFor(operation: ChangeSetOperation): string {
  switch (operation) {
    case 'get':
      return 'We couldn’t load this change set.'
    case 'list-recent':
      return 'We couldn’t load change sets.'
    case 'create':
      return 'We couldn’t prepare this change set.'
  }
}

/**
 * Maps any change-set-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicChangeSetError(operation: ChangeSetOperation, error: unknown): Error {
  if (error instanceof ChangeSetNotFoundError) {
    return new Error(error.message)
  }
  if (error instanceof InvalidChangeSetRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof ChangeSetError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
