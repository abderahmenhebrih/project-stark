/**
 * Shared STARK cloud-account contract (Stage 29).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * STARK remains LOCAL-FIRST: signing in never uploads Workspace files,
 * sessions, transactions, settings, runtimes, usage, or provider keys.
 * The account is an OPTIONAL cloud identity layer (Google/GitHub only)
 * whose tokens never leave the main process.
 */

/** Main-owned OAuth provider union. Exactly these two — nothing else. */
export type StarkAuthProvider = 'google' | 'github'

/** Renderer-safe account identity. No tokens, no UUIDs, no raw payloads. */
export interface SafeCloudAccount {
  readonly provider: StarkAuthProvider
  readonly email: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
}

/**
 * Renderer-safe account status. No access token, refresh token, OAuth
 * code, PKCE verifier, raw user, or raw session anywhere in this union.
 */
export type CloudAccountStatus =
  | { readonly state: 'unavailable' }
  | { readonly state: 'signed_out' }
  | { readonly state: 'signing_in'; readonly provider: StarkAuthProvider }
  | { readonly state: 'signed_in'; readonly account: SafeCloudAccount }
  | {
      readonly state: 'session_attention'
      readonly account: SafeCloudAccount
      readonly reason: 'expired' | 'invalid'
    }

/** Renderer → main start-sign-in request. Provider enum only — no URLs. */
export interface StartSignInRequest {
  readonly provider: StarkAuthProvider
}

/** Safe start-sign-in result. No token/provider result yet. */
export interface StartSignInResult {
  readonly outcome: 'browser_opened'
  readonly provider: StarkAuthProvider
}

/** Account slice of the preload bridge (`window.stark.account`). */
export interface CloudAccountApi {
  getStatus: () => Promise<CloudAccountStatus>
  startSignIn: (request: StartSignInRequest) => Promise<StartSignInResult>
  cancelSignIn: () => Promise<CloudAccountStatus>
  signOut: () => Promise<CloudAccountStatus>
  onUpdated: (listener: (status: CloudAccountStatus) => void) => () => void
}

function isSafeProvider(value: unknown): value is StarkAuthProvider {
  return value === 'google' || value === 'github'
}

function isSafeStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isSafeAccount(value: unknown): value is SafeCloudAccount {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4) {
    return false
  }
  return (
    isSafeProvider(record['provider']) &&
    isSafeStringOrNull(record['email']) &&
    isSafeStringOrNull(record['displayName']) &&
    isSafeStringOrNull(record['avatarUrl'])
  )
}

/**
 * Validates an untrusted main→renderer account status payload.
 * Preload uses this before invoking renderer listeners; renderers use
 * it before accepting pushed updates. Rejects anything with tokens,
 * codes, sessions, or unexpected shapes.
 */
export function isCloudAccountStatus(value: unknown): value is CloudAccountStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  const state = record['state']
  // Reject any payload carrying secret-bearing keys, even alongside a
  // valid state — defense in depth against future regressions.
  for (const forbidden of [
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'code',
    'session',
    'verifier',
    'oauthUrl',
    'redirectUrl',
    'token'
  ]) {
    if (forbidden in record) {
      return false
    }
  }
  switch (state) {
    case 'unavailable':
    case 'signed_out':
      return Object.keys(record).length === 1
    case 'signing_in': {
      if (Object.keys(record).length !== 2) {
        return false
      }
      return isSafeProvider(record['provider'])
    }
    case 'signed_in': {
      if (Object.keys(record).length !== 2) {
        return false
      }
      return isSafeAccount(record['account'])
    }
    case 'session_attention': {
      if (Object.keys(record).length !== 3) {
        return false
      }
      const reason = record['reason']
      return (reason === 'expired' || reason === 'invalid') && isSafeAccount(record['account'])
    }
    default:
      return false
  }
}
