import { toPublicProviderError } from './errors'
import { AiProviderError } from './errors'

/**
 * Brain orchestration errors (Stage 18).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain prompts, Worker output, file
 * contents, absolute paths, SQL, IPC channel names, provider bodies,
 * or stack traces. Error categories persisted on failed runs reuse
 * these same stable strings.
 */

export class AiBrainError extends Error {
  override readonly name: string = 'AiBrainError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Orchestration request payload failed runtime validation. */
export class InvalidBrainRequestError extends AiBrainError {
  override readonly name = 'InvalidBrainRequestError'
}

/** Latest session message is not a user message. */
export class BrainNothingToAnswerError extends AiBrainError {
  override readonly name = 'BrainNothingToAnswerError'

  constructor() {
    super('There is no new message for STARK to answer.')
  }
}

/** Structured Brain plan failed validation. */
export class InvalidBrainPlanError extends AiBrainError {
  override readonly name = 'InvalidBrainPlanError'

  constructor() {
    super('STARK could not form a valid work plan.')
  }
}

/** Worker output failed validation. */
export class InvalidWorkerOutputError extends AiBrainError {
  override readonly name = 'InvalidWorkerOutputError'

  constructor() {
    super('STARK could not complete the delegated work.')
  }
}

/** Brain synthesis output failed validation. */
export class InvalidBrainSynthesisError extends AiBrainError {
  override readonly name = 'InvalidBrainSynthesisError'

  constructor() {
    super('STARK could not complete the final response.')
  }
}

/** A previous run left running (e.g. crash recovery marker). */
export class BrainRunInterruptedError extends AiBrainError {
  override readonly name = 'BrainRunInterruptedError'

  constructor() {
    super('A previous work run was interrupted. Start a new one explicitly.')
  }
}

export type BrainOperation = 'run' | 'get' | 'list-recent'

function genericFor(operation: BrainOperation): string {
  switch (operation) {
    case 'run':
      return 'We couldn’t complete this work run.'
    case 'get':
      return 'We couldn’t load this work run.'
    case 'list-recent':
      return 'We couldn’t load work runs.'
  }
}

/**
 * Maps any Brain-layer failure to a renderer-safe Error carrying
 * displayable copy only. Provider-layer failures keep their own safe
 * copy via the provider mapping.
 */
export function toPublicBrainError(operation: BrainOperation, error: unknown): Error {
  if (
    error instanceof BrainNothingToAnswerError ||
    error instanceof InvalidBrainPlanError ||
    error instanceof InvalidWorkerOutputError ||
    error instanceof InvalidBrainSynthesisError ||
    error instanceof BrainRunInterruptedError
  ) {
    return new Error(error.message)
  }
  if (error instanceof AiProviderError) {
    return toPublicProviderError('generate', error)
  }
  if (error instanceof InvalidBrainRequestError) {
    return new Error(operation === 'run' ? 'We couldn’t start this work run.' : genericFor(operation))
  }
  if (error instanceof AiBrainError) {
    return new Error(genericFor(operation))
  }
  const mapped = toPublicProviderError('generate', error)
  if (mapped.message !== 'We couldn’t get a response from the AI provider.') {
    return mapped
  }
  return new Error(genericFor(operation))
}
