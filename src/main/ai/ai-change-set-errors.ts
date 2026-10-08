import { toPublicProviderError } from './errors'
import { AiProviderError } from './errors'

/**
 * AI multi-file proposal errors (Stage 17).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain file contents, absolute paths,
 * target-ID mappings, SQL, IPC channel names, provider bodies, or
 * stack traces.
 */

export class AiChangeSetError extends Error {
  override readonly name: string = 'AiChangeSetError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Proposal request payload failed runtime validation. */
export class InvalidChangeSetRequestError extends AiChangeSetError {
  override readonly name = 'InvalidChangeSetRequestError'
}

/** Persisted context does not satisfy the 2–5 whole-file rule. */
export class ChangeSetContextMissingError extends AiChangeSetError {
  override readonly name = 'ChangeSetContextMissingError'

  constructor() {
    super('Attach two to five whole files to propose grouped code changes.')
  }
}

/** Latest session message is not a user message. */
export class ChangeSetNothingToProposeError extends AiChangeSetError {
  override readonly name = 'ChangeSetNothingToProposeError'

  constructor() {
    super('There is no new message to propose changes for.')
  }
}

/** Any attached file moved after attach but before the provider call. */
export class ChangeSetStaleBeforeProviderError extends AiChangeSetError {
  override readonly name = 'ChangeSetStaleBeforeProviderError'

  constructor() {
    super('One of the attached files changed after you attached it. Attach the changed files again before requesting a proposal.')
  }
}

/** A proposed target moved during generation; nothing was persisted. */
export class ChangeSetStaleDuringProviderError extends AiChangeSetError {
  override readonly name = 'ChangeSetStaleDuringProviderError'

  constructor(options?: { cause?: unknown }) {
    super('One of the files changed while STARK was preparing the proposal. Attach it again and try again.', options)
  }
}

/** Every returned change was a no-op. */
export class ChangeSetNoChangesError extends AiChangeSetError {
  override readonly name = 'ChangeSetNoChangesError'

  constructor() {
    super('STARK did not propose any code changes.')
  }
}

/** Structured model output failed validation. */
export class InvalidChangeSetOutputError extends AiChangeSetError {
  override readonly name = 'InvalidChangeSetOutputError'

  constructor() {
    super('STARK could not create a valid grouped code proposal.')
  }
}

/** Combined proposed content exceeds the 256 KiB bound. */
export class ChangeSetTooLargeError extends AiChangeSetError {
  override readonly name = 'ChangeSetTooLargeError'

  constructor() {
    super('The grouped proposed changes are too large.')
  }
}

export type ChangeSetProposalOperation = 'propose-set'

/**
 * Maps any change-set proposal failure to a renderer-safe Error
 * carrying displayable copy only. Provider-layer failures keep their
 * own safe copy via the provider mapping.
 */
export function toPublicChangeSetProposalError(operation: ChangeSetProposalOperation, error: unknown): Error {
  void operation
  if (
    error instanceof ChangeSetContextMissingError ||
    error instanceof ChangeSetNothingToProposeError ||
    error instanceof ChangeSetStaleBeforeProviderError ||
    error instanceof ChangeSetStaleDuringProviderError ||
    error instanceof ChangeSetNoChangesError ||
    error instanceof InvalidChangeSetOutputError ||
    error instanceof ChangeSetTooLargeError
  ) {
    return new Error(error.message)
  }
  if (error instanceof AiProviderError) {
    return toPublicProviderError('generate', error)
  }
  if (error instanceof InvalidChangeSetRequestError) {
    return new Error('We couldn’t prepare this grouped code proposal.')
  }
  if (error instanceof AiChangeSetError) {
    return new Error('We couldn’t prepare this grouped code proposal.')
  }
  const mapped = toPublicProviderError('generate', error)
  if (mapped.message !== 'We couldn’t get a response from the AI provider.') {
    return mapped
  }
  return new Error('We couldn’t prepare this grouped code proposal.')
}
