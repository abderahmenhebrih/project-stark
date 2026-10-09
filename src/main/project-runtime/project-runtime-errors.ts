/**
 * Project-runtime domain errors (Stage 26).
 *
 * Public messages are stable user-facing copy. They never contain
 * credentials, absolute paths, env vars, provider bodies, SQL, IPC
 * channels, PIDs, or stack traces. Runtime output travels as data,
 * never as authority.
 */

export class ProjectRuntimeError extends Error {
  override readonly name: string = 'ProjectRuntimeError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A runtime request failed validation or ownership checks. */
export class InvalidRuntimeRequestError extends ProjectRuntimeError {
  override readonly name = 'InvalidRuntimeRequestError'
}

export type ProjectRuntimeOperation = 'read' | 'stop' | 'preview'

function genericFor(operation: ProjectRuntimeOperation): string {
  switch (operation) {
    case 'read':
      return 'We couldn’t load the project runtime.'
    case 'stop':
      return 'We couldn’t stop the project runtime.'
    case 'preview':
      return 'We couldn’t open the live preview.'
  }
}

/**
 * Maps any runtime-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicProjectRuntimeError(operation: ProjectRuntimeOperation, error: unknown): Error {
  if (error instanceof InvalidRuntimeRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof ProjectRuntimeError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
