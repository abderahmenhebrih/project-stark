/**
 * STARK cloud-account errors (Stage 29).
 *
 * Public messages are stable safe categories the renderer may match on.
 * They never contain authorization codes, tokens, PKCE verifiers, OAuth
 * URLs, callback URLs, Supabase bodies, SQL, or stacks.
 */

export class CloudAccountError extends Error {
  override readonly name: string = 'CloudAccountError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** Supabase public config missing — local STARK stays fully usable. */
export class CloudAuthUnavailableError extends CloudAccountError {
  override readonly name = 'CloudAuthUnavailableError'

  constructor() {
    super('cloud-auth-unavailable')
  }
}

/** Exactly one pending OAuth attempt at a time. */
export class CloudAuthInProgressError extends CloudAccountError {
  override readonly name = 'CloudAuthInProgressError'

  constructor() {
    super('cloud-auth-in-progress')
  }
}

/** Provider outside the google|github union. */
export class CloudAuthInvalidProviderError extends CloudAccountError {
  override readonly name = 'CloudAuthInvalidProviderError'

  constructor() {
    super('cloud-auth-invalid-provider')
  }
}

/** Malformed, unsolicited, wrong-target, or replayed callback. */
export class CloudAuthCallbackInvalidError extends CloudAccountError {
  override readonly name = 'CloudAuthCallbackInvalidError'

  constructor() {
    super('cloud-auth-callback-invalid')
  }
}

/** Callback arrived after the 5-minute attempt deadline. */
export class CloudAuthCallbackExpiredError extends CloudAccountError {
  override readonly name = 'CloudAuthCallbackExpiredError'

  constructor() {
    super('cloud-auth-callback-expired')
  }
}

/** OAuth URL generation or authorization-code exchange failed. */
export class CloudAuthExchangeFailedError extends CloudAccountError {
  override readonly name = 'CloudAuthExchangeFailedError'

  constructor(options?: { cause?: unknown }) {
    super('cloud-auth-exchange-failed', options)
  }
}

/** OS secure storage cannot persist the session — fail closed. */
export class CloudAuthSecureStorageUnavailableError extends CloudAccountError {
  override readonly name = 'CloudAuthSecureStorageUnavailableError'

  constructor() {
    super('cloud-auth-secure-storage-unavailable')
  }
}

/** OAuth succeeded but the atomic local persistence failed. */
export class CloudAuthSaveFailedError extends CloudAccountError {
  override readonly name = 'CloudAuthSaveFailedError'

  constructor(options?: { cause?: unknown }) {
    super('cloud-auth-save-failed', options)
  }
}

/** Local sign-out clear failed. */
export class CloudAuthSignOutFailedError extends CloudAccountError {
  override readonly name = 'CloudAuthSignOutFailedError'

  constructor(options?: { cause?: unknown }) {
    super('cloud-auth-signout-failed', options)
  }
}

export type CloudAccountOperation = 'status' | 'start' | 'cancel' | 'sign-out' | 'callback' | 'restore'

const GENERIC_BY_OPERATION: Record<CloudAccountOperation, string> = {
  status: 'cloud-auth-unavailable',
  start: 'cloud-auth-exchange-failed',
  cancel: 'cloud-auth-unavailable',
  'sign-out': 'cloud-auth-signout-failed',
  callback: 'cloud-auth-callback-invalid',
  restore: 'cloud-auth-unavailable'
}

/**
 * Maps any cloud-account failure to a renderer-safe Error carrying only
 * a stable category string. Never leaks codes, tokens, URLs, or SQL.
 */
export function toPublicAccountError(operation: CloudAccountOperation, error: unknown): Error {
  if (
    error instanceof CloudAuthUnavailableError ||
    error instanceof CloudAuthInProgressError ||
    error instanceof CloudAuthInvalidProviderError ||
    error instanceof CloudAuthCallbackInvalidError ||
    error instanceof CloudAuthCallbackExpiredError ||
    error instanceof CloudAuthExchangeFailedError ||
    error instanceof CloudAuthSecureStorageUnavailableError ||
    error instanceof CloudAuthSaveFailedError ||
    error instanceof CloudAuthSignOutFailedError
  ) {
    return new Error(error.message)
  }
  void operation
  return new Error(GENERIC_BY_OPERATION[operation])
}

/** True when a message is one of the stable public categories. */
export function isPublicAccountErrorMessage(message: string): boolean {
  return (
    message === 'cloud-auth-unavailable' ||
    message === 'cloud-auth-in-progress' ||
    message === 'cloud-auth-invalid-provider' ||
    message === 'cloud-auth-callback-invalid' ||
    message === 'cloud-auth-callback-expired' ||
    message === 'cloud-auth-exchange-failed' ||
    message === 'cloud-auth-secure-storage-unavailable' ||
    message === 'cloud-auth-save-failed' ||
    message === 'cloud-auth-signout-failed'
  )
}
