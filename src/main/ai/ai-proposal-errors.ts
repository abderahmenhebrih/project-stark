import { toPublicProviderError, AiProviderError, type ProviderOperation } from './errors'

/**
 * AI code-proposal errors (Stage 16).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain file contents, absolute paths,
 * SQL, IPC channel names, provider bodies, or stack traces.
 */

export class AiProposalError extends Error {
  override readonly name: string = 'AiProposalError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Proposal request payload failed runtime validation. */
export class InvalidProposalRequestError extends AiProposalError {
  override readonly name = 'InvalidProposalRequestError'
}

/** Persisted context does not satisfy the one-whole-file rule. */
export class ProposalContextMissingError extends AiProposalError {
  override readonly name = 'ProposalContextMissingError'

  constructor() {
    super('Attach exactly one whole file to propose a code change.')
  }
}

/** Latest session message is not a user message. */
export class ProposalNothingToProposeError extends AiProposalError {
  override readonly name = 'ProposalNothingToProposeError'

  constructor() {
    super('There is no new message to propose a change for.')
  }
}

/** Disk moved after attach but before the provider call. */
export class ProposalStaleBeforeProviderError extends AiProposalError {
  override readonly name = 'ProposalStaleBeforeProviderError'

  constructor() {
    super('This file changed after you attached it. Attach it again before requesting a change.')
  }
}

/** Disk moved during the provider call; transaction creation refused. */
export class ProposalStaleDuringProviderError extends AiProposalError {
  override readonly name = 'ProposalStaleDuringProviderError'

  constructor(options?: { cause?: unknown }) {
    super('The file changed while STARK was preparing the proposal. Attach it again and try again.', options)
  }
}

/** Model returned no effective change. */
export class ProposalNoChangesError extends AiProposalError {
  override readonly name = 'ProposalNoChangesError'

  constructor() {
    super('STARK did not propose any code changes.')
  }
}

/** Structured model output failed validation. */
export class InvalidProposalOutputError extends AiProposalError {
  override readonly name = 'InvalidProposalOutputError'

  constructor() {
    super('STARK could not create a valid code proposal.')
  }
}

/** Proposed replacement exceeds the 64 KiB bound. */
export class ProposalTooLargeError extends AiProposalError {
  override readonly name = 'ProposalTooLargeError'

  constructor() {
    super('The proposed change is too large.')
  }
}

export type ProposalOperation = 'propose'

/**
 * Maps any proposal-layer failure to a renderer-safe Error carrying
 * displayable copy only. Provider-layer failures keep their own safe
 * copy via the provider mapping.
 */
export function toPublicProposalError(operation: ProposalOperation, error: unknown): Error {
  void operation
  if (
    error instanceof ProposalContextMissingError ||
    error instanceof ProposalNothingToProposeError ||
    error instanceof ProposalStaleBeforeProviderError ||
    error instanceof ProposalStaleDuringProviderError ||
    error instanceof ProposalNoChangesError ||
    error instanceof InvalidProposalOutputError ||
    error instanceof ProposalTooLargeError
  ) {
    return new Error(error.message)
  }
  if (error instanceof AiProviderError) {
    return toPublicProviderError('generate', error)
  }
  if (error instanceof InvalidProposalRequestError) {
    return new Error('We couldn’t prepare this code proposal.')
  }
  if (error instanceof AiProposalError) {
    return new Error('We couldn’t prepare this code proposal.')
  }
  const mapped = toPublicProviderError('generate' satisfies ProviderOperation, error)
  if (mapped.message !== 'We couldn’t get a response from the AI provider.') {
    return mapped
  }
  return new Error('We couldn’t prepare this code proposal.')
}
