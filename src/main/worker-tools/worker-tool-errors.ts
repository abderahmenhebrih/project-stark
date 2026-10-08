/**
 * Worker tool errors (Stage 23).
 *
 * Public messages are stable user-facing copy. They never contain
 * credentials, absolute paths, env vars, provider bodies, SQL, IPC
 * channels, or stack traces. Tool contents travel as data, never as
 * authority.
 */

export class WorkerToolError extends Error {
  override readonly name: string = 'WorkerToolError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A Worker tool request failed validation. */
export class InvalidWorkerToolRequestError extends WorkerToolError {
  override readonly name = 'InvalidWorkerToolRequestError'
}

/** The Worker exceeded its bounded tool budget. */
export class WorkerToolLimitError extends WorkerToolError {
  override readonly name = 'WorkerToolLimitError'

  constructor() {
    super('STARK reached the Worker tool limit for this run.')
  }
}

/** The Worker model cannot use read-only tools. */
export class WorkerToolsUnsupportedError extends WorkerToolError {
  override readonly name = 'WorkerToolsUnsupportedError'

  constructor() {
    super('The selected Worker model does not support STARK read-only tools.')
  }
}

/** A pending approval blocks a new AI operation in the session. */
export class PendingApprovalBlockedError extends WorkerToolError {
  override readonly name = 'PendingApprovalBlockedError'

  constructor() {
    super('Resolve the pending STARK approval before starting another AI operation.')
  }
}

/** An approval is no longer usable. */
export class WorkerApprovalExpiredError extends WorkerToolError {
  override readonly name = 'WorkerApprovalExpiredError'

  constructor() {
    super('This Worker approval expired. Start the Work request again.')
  }
}

/** Marks a provider failure that occurred after tool interaction (no auto-recovery). */
export class ToolInteractiveError extends WorkerToolError {
  override readonly name = 'ToolInteractiveError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t complete this work run.', options)
  }
}

export type WorkerToolOperation = 'run' | 'approve' | 'lookup'

function genericFor(operation: WorkerToolOperation): string {
  switch (operation) {
    case 'run':
      return 'We couldn’t complete this work run.'
    case 'approve':
      return 'We couldn’t resolve this approval.'
    case 'lookup':
      return 'We couldn’t load the pending approval.'
  }
}

/**
 * Maps any tool-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicWorkerToolError(operation: WorkerToolOperation, error: unknown): Error {
  if (
    error instanceof WorkerToolLimitError ||
    error instanceof WorkerToolsUnsupportedError ||
    error instanceof PendingApprovalBlockedError ||
    error instanceof WorkerApprovalExpiredError
  ) {
    return new Error(error.message)
  }
  if (error instanceof InvalidWorkerToolRequestError) {
    return new Error(genericFor(operation))
  }
  if (error instanceof WorkerToolError) {
    return new Error(genericFor(operation))
  }
  return new Error(genericFor(operation))
}
