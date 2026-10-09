/**
 * Renderer-side error boundary for STARK account operations.
 *
 * Electron wraps every `ipcRenderer.invoke` rejection in transport
 * wording, so raw `Error.message` must never reach the UI. Only the
 * stable safe categories produced by the main-process account mapping
 * are recognized; codes, tokens, URLs, SQL, and anything unrecognized
 * collapse to the caller fallback.
 */

export type AccountErrorKind =
  | 'unavailable'
  | 'in-progress'
  | 'invalid-provider'
  | 'callback-invalid'
  | 'callback-expired'
  | 'exchange-failed'
  | 'secure-storage-unavailable'
  | 'save-failed'
  | 'signout-failed'
  | 'generic'

export interface NormalizedAccountError {
  readonly kind: AccountErrorKind
  readonly message: string
}

export const ACCOUNT_UNAVAILABLE_MESSAGE = 'Cloud account features are unavailable in this build.'
export const ACCOUNT_IN_PROGRESS_MESSAGE = 'An account sign-in is already in progress.'
export const ACCOUNT_INVALID_PROVIDER_MESSAGE = 'That sign-in provider is not available.'
export const ACCOUNT_CALLBACK_INVALID_MESSAGE = 'That sign-in link is invalid. Start again.'
export const ACCOUNT_CALLBACK_EXPIRED_MESSAGE = 'That sign-in attempt expired. Start again.'
export const ACCOUNT_EXCHANGE_FAILED_MESSAGE = 'We couldn’t finish signing in. Try again.'
export const ACCOUNT_SECURE_STORAGE_MESSAGE = 'STARK could not securely store this account session on this device.'
export const ACCOUNT_SAVE_FAILED_MESSAGE = 'We couldn’t save this account session.'
export const ACCOUNT_SIGNOUT_FAILED_MESSAGE = 'We couldn’t sign out. Try again.'
export const ACCOUNT_GENERIC_MESSAGE = 'We couldn’t update the account. Try again.'

const KNOWN_OUTCOMES: readonly { readonly kind: AccountErrorKind; readonly code: string; readonly message: string }[] = [
  { kind: 'unavailable', code: 'cloud-auth-unavailable', message: ACCOUNT_UNAVAILABLE_MESSAGE },
  { kind: 'in-progress', code: 'cloud-auth-in-progress', message: ACCOUNT_IN_PROGRESS_MESSAGE },
  { kind: 'invalid-provider', code: 'cloud-auth-invalid-provider', message: ACCOUNT_INVALID_PROVIDER_MESSAGE },
  { kind: 'callback-invalid', code: 'cloud-auth-callback-invalid', message: ACCOUNT_CALLBACK_INVALID_MESSAGE },
  { kind: 'callback-expired', code: 'cloud-auth-callback-expired', message: ACCOUNT_CALLBACK_EXPIRED_MESSAGE },
  { kind: 'exchange-failed', code: 'cloud-auth-exchange-failed', message: ACCOUNT_EXCHANGE_FAILED_MESSAGE },
  { kind: 'secure-storage-unavailable', code: 'cloud-auth-secure-storage-unavailable', message: ACCOUNT_SECURE_STORAGE_MESSAGE },
  { kind: 'save-failed', code: 'cloud-auth-save-failed', message: ACCOUNT_SAVE_FAILED_MESSAGE },
  { kind: 'signout-failed', code: 'cloud-auth-signout-failed', message: ACCOUNT_SIGNOUT_FAILED_MESSAGE }
]

/**
 * Normalizes any thrown account failure to canonical display-safe
 * copy, falling back to the caller-supplied message.
 */
export function normalizeAccountError(error: unknown, fallback: string = ACCOUNT_GENERIC_MESSAGE): NormalizedAccountError {
  if (error instanceof Error && error.message !== '') {
    const transported = error.message
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.code)) {
        return { kind: outcome.kind, message: outcome.message }
      }
    }
    // Already-normalized display copy passes through when it matches.
    for (const outcome of KNOWN_OUTCOMES) {
      if (transported.includes(outcome.message)) {
        return { kind: outcome.kind, message: outcome.message }
      }
    }
  }
  return { kind: 'generic', message: fallback }
}
