/**
 * Usage-domain errors (Stage 28).
 *
 * Public messages are stable user-facing copy: renderers may display
 * them directly. They never contain API keys, prompts, responses,
 * request bodies, or provider internals.
 */

export class InvalidUsageRequestError extends Error {
  override readonly name = 'InvalidUsageRequestError'

  constructor(message = 'The usage request is invalid.') {
    super(message)
  }
}

export class InvalidUsageConfigError extends Error {
  override readonly name = 'InvalidUsageConfigError'

  constructor(message = 'The usage routing configuration is invalid.') {
    super(message)
  }
}

export class UsageWorkspaceNotFoundError extends Error {
  override readonly name = 'UsageWorkspaceNotFoundError'

  constructor() {
    super('That project folder is no longer available.')
  }
}

/**
 * Maps any usage-layer failure to a renderer-safe Error carrying
 * displayable copy only.
 */
export function toPublicUsageError(operation: 'get' | 'update' | 'summary', error: unknown): Error {
  if (error instanceof InvalidUsageConfigError || error instanceof InvalidUsageRequestError) {
    return new Error(error.message)
  }
  if (error instanceof UsageWorkspaceNotFoundError) {
    return new Error(error.message)
  }
  switch (operation) {
    case 'get':
      return new Error('We couldn’t load the usage configuration.')
    case 'update':
      return new Error('We couldn’t save the usage routing configuration.')
    case 'summary':
      return new Error('We couldn’t load the local usage summary.')
  }
}
