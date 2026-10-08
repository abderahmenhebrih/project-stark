/**
 * AI provider/completion errors (Stage 14).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain API keys, request bodies,
 * Authorization headers, provider JSON bodies, stack traces, IPC
 * channel names, or Electron invoke prefixes.
 */

export class AiProviderError extends Error {
  override readonly name: string = 'AiProviderError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** A request payload failed runtime validation. */
export class InvalidProviderRequestError extends AiProviderError {
  override readonly name = 'InvalidProviderRequestError'
}

/** Unknown provider id. */
export class UnknownProviderError extends AiProviderError {
  override readonly name = 'UnknownProviderError'

  constructor() {
    super('That AI provider is not available.')
  }
}

/** OS secure storage cannot hold credentials on this system. */
export class SecureStorageUnavailableError extends AiProviderError {
  override readonly name = 'SecureStorageUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('Secure credential storage is not available on this system.', options)
  }
}

/** No credential is stored for the provider. */
export class ProviderCredentialMissingError extends AiProviderError {
  override readonly name = 'ProviderCredentialMissingError'

  constructor() {
    super('No API key is saved for this provider yet.')
  }
}

/** A stored key failed its write-read-decrypt verification round trip. */
export class ProviderStorageVerificationError extends AiProviderError {
  override readonly name = 'ProviderStorageVerificationError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t store this API key securely.', options)
  }
}

/** The stored credential was rejected by the provider. */
export class ProviderInvalidCredentialError extends AiProviderError {
  override readonly name = 'ProviderInvalidCredentialError'

  constructor(options?: { cause?: unknown }) {
    super('The saved API key was rejected. Check the key and try again.', options)
  }
}

/**
 * Authenticated but forbidden (normally HTTP 403): the key lacks
 * permission for the request, e.g. wrong project scope. Deliberately
 * distinct from invalid-credential so a valid key is never reported
 * as rejected.
 */
export class ProviderForbiddenError extends AiProviderError {
  override readonly name = 'ProviderForbiddenError'

  constructor(options?: { cause?: unknown }) {
    super('The API key does not have permission for this request. Check the key’s project permissions and try again.', options)
  }
}

/** The provider throttled the request. */
export class ProviderRateLimitedError extends AiProviderError {
  override readonly name = 'ProviderRateLimitedError'

  constructor(options?: { cause?: unknown }) {
    super('The AI provider is rate-limiting requests. Try again shortly.', options)
  }
}

/** The provider request timed out (single attempt, no retry). */
export class ProviderTimeoutError extends AiProviderError {
  override readonly name = 'ProviderTimeoutError'

  constructor(options?: { cause?: unknown }) {
    super('The AI provider request timed out. Try again.', options)
  }
}

/** The network was unreachable. */
export class ProviderNetworkError extends AiProviderError {
  override readonly name = 'ProviderNetworkError'

  constructor(options?: { cause?: unknown }) {
    super('The AI provider could not be reached. Check your connection.', options)
  }
}

/** The selected model cannot serve the request. */
export class ProviderModelUnavailableError extends AiProviderError {
  override readonly name = 'ProviderModelUnavailableError'

  constructor(options?: { cause?: unknown }) {
    super('The selected model is not available. Choose another model.', options)
  }
}

/** No usable text came back from the provider. */
export class ProviderEmptyResponseError extends AiProviderError {
  override readonly name = 'ProviderEmptyResponseError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t get a response from the AI provider.', options)
  }
}

/** Unclassified provider failure. */
export class ProviderGenericError extends AiProviderError {
  override readonly name = 'ProviderGenericError'

  constructor(options?: { cause?: unknown }) {
    super('We couldn’t get a response from the AI provider.', options)
  }
}

/** A generation is already running for the session. */
export class GenerationInFlightError extends AiProviderError {
  override readonly name = 'GenerationInFlightError'

  constructor() {
    super('STARK is already generating a response for this session.')
  }
}

/** The session has no new user message to answer. */
export class NothingToAnswerError extends AiProviderError {
  override readonly name = 'NothingToAnswerError'

  constructor() {
    super('There is no new message for STARK to answer.')
  }
}

/** No model is selected for the provider. */
export class ProviderModelMissingError extends AiProviderError {
  override readonly name = 'ProviderModelMissingError'

  constructor() {
    super('No AI model is selected yet.')
  }
}

/** The selected model cannot serve a structured-output request. */
export class ProviderStructuredOutputUnsupportedError extends AiProviderError {
  override readonly name = 'ProviderStructuredOutputUnsupportedError'

  constructor(options?: { cause?: unknown }) {
    super('The selected model could not create a structured code proposal. Choose another model.', options)
  }
}

export type ProviderOperation = 'state' | 'save' | 'clear' | 'test' | 'models' | 'set-model' | 'generate'

function genericFor(operation: ProviderOperation): string {
  switch (operation) {
    case 'state':
    case 'clear':
      return 'We couldn’t load the AI provider settings.'
    case 'save':
      return 'We couldn’t save this API key.'
    case 'test':
    case 'models':
      return 'We couldn’t reach the AI provider.'
    case 'set-model':
      return 'We couldn’t select this model.'
    case 'generate':
      return 'We couldn’t get a response from the AI provider.'
  }
}

import {
  InvalidSessionRequestError,
  SessionNotFoundError,
  SessionWorkspaceMismatchError,
  SessionWorkspaceUnavailableError
} from '../sessions/errors'

/**
 * Maps any AI-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicProviderError(operation: ProviderOperation, error: unknown): Error {
  if (
    error instanceof SecureStorageUnavailableError ||
    error instanceof ProviderCredentialMissingError ||
    error instanceof ProviderStorageVerificationError ||
    error instanceof ProviderInvalidCredentialError ||
    error instanceof ProviderForbiddenError ||
    error instanceof ProviderRateLimitedError ||
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderModelUnavailableError ||
    error instanceof ProviderEmptyResponseError ||
    error instanceof ProviderGenericError ||
    error instanceof GenerationInFlightError ||
    error instanceof NothingToAnswerError ||
    error instanceof ProviderModelMissingError ||
    error instanceof ProviderStructuredOutputUnsupportedError ||
    error instanceof UnknownProviderError
  ) {
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
  return new Error(genericFor(operation))
}
