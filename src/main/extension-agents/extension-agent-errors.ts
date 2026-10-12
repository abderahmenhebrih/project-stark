/**
 * Public-safe extension-agent errors (main-side).
 *
 * Every message is safe to surface to the renderer: no paths beyond
 * the rejected shape, no provider internals, no credentials. The IPC
 * binding maps unknown failures to the generic copy below.
 */

export class ExtensionAgentRequestError extends Error {
  constructor() {
    super('That agent request is not valid.')
    this.name = 'ExtensionAgentRequestError'
  }
}

export class ExtensionAgentNotAvailableError extends Error {
  constructor(reason?: string) {
    super(typeof reason === 'string' && reason !== '' ? reason : 'That extension agent is not available.')
    this.name = 'ExtensionAgentNotAvailableError'
  }
}

export class ExtensionAgentNothingToAnswerError extends Error {
  constructor() {
    super('There is nothing to answer yet.')
    this.name = 'ExtensionAgentNothingToAnswerError'
  }
}

export class ExtensionAgentResponseError extends Error {
  constructor() {
    super('That agent returned an unusable response. No changes were made.')
    this.name = 'ExtensionAgentResponseError'
  }
}

/** Maps any run failure to a public-safe error (known safe copies pass through). */
export function toPublicExtensionAgentError(scope: string, error: unknown): Error {
  if (
    error instanceof ExtensionAgentRequestError ||
    error instanceof ExtensionAgentNotAvailableError ||
    error instanceof ExtensionAgentNothingToAnswerError ||
    error instanceof ExtensionAgentResponseError
  ) {
    return error
  }
  // The command boundary (activation, trust, timeout, unsupported
  // API) already throws public-safe errors — preserve them verbatim.
  if (error instanceof Error && error.message !== '') {
    const known = [
      'That extension timed out. No changes were made.',
      'This extension requires a VS Code API that STARK does not support yet.',
      'That extension could not be activated.',
      'That command request is not valid.',
      'The Extension Host is unavailable.'
    ]
    if (known.some((marker) => error.message.includes(marker))) {
      return error
    }
  }
  return new Error(`We couldn’t complete that agent ${scope}. No changes were made.`)
}
