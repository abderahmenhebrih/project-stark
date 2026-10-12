import type { StarkAuthProvider } from '../../shared/cloud-account/types'
import { CloudAuthSignInRequiredError, CloudAuthSecureStorageUnavailableError, CloudAuthUnavailableError } from './cloud-account-errors'
import type { CloudAccountRepository } from './cloud-account-repository'
import type { CloudAuthAdapter, NormalizedCloudIdentity } from './cloud-account-types'
import { SessionProtector } from './cloud-auth-session-store'

/** Proactive renewal margin: tokens expiring within 60s are refreshed. */
const HOSTED_TOKEN_REFRESH_MARGIN_MS = 60_000

export interface HostedAccessTokenDeps {
  readonly repository: CloudAccountRepository
  readonly protector: SessionProtector
  readonly adapter: CloudAuthAdapter
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
}

/**
 * Returns a valid Supabase access token for exactly one hosted
 * inference call. The token is main-owned end to end: callers must
 * drop the reference immediately after use and never persist, log,
 * or forward it.
 *
 * Steady state performs zero network I/O (the stored expiry is
 * trusted inside a refresh margin). An expired token triggers
 * exactly one bounded adapter restore (the SDK refreshes via the
 * stored refresh token when still valid) and the rotated envelope
 * is re-persisted atomically with the stored identity re-stamped —
 * never invented.
 *
 * Throws CloudAuthSignInRequiredError when no usable session exists
 * (signed out, expired beyond refresh, corrupt, or mismatched) and
 * CloudAuthUnavailableError when auth is unconfigured. Secure-storage
 * failures propagate unchanged (fail closed — re-login cannot fix a
 * broken store). No polling, no timers, no retries, no logging of
 * session material.
 */
export async function getValidHostedAccessToken(deps: HostedAccessTokenDeps): Promise<string> {
  const now = deps.now ?? Date.now
  if (!deps.adapter.isConfigured()) {
    throw new CloudAuthUnavailableError()
  }
  const account = deps.repository.findAccount()
  if (account === undefined) {
    throw new CloudAuthSignInRequiredError()
  }
  const stored = deps.repository.findEncryptedSession()
  if (stored === undefined) {
    throw new CloudAuthSignInRequiredError()
  }
  let accessToken: string
  let refreshToken: string
  let userId: string
  let expiresAt: number | null
  try {
    const envelope = await deps.protector.open(stored.encryptedSession)
    accessToken = envelope.accessToken
    refreshToken = envelope.refreshToken
    userId = envelope.userId
    expiresAt = envelope.expiresAt
  } catch (error) {
    if (error instanceof CloudAuthSecureStorageUnavailableError) {
      throw error
    }
    throw new CloudAuthSignInRequiredError()
  }
  if (userId !== account.cloudUserId) {
    throw new CloudAuthSignInRequiredError()
  }
  if (expiresAt === null || expiresAt - HOSTED_TOKEN_REFRESH_MARGIN_MS > now()) {
    return accessToken
  }
  let restored: { identity: NormalizedCloudIdentity; session: { accessToken: string; refreshToken: string; expiresAt: number | null; userId: string } } | null
  try {
    restored = await deps.adapter.restoreSession({ accessToken, refreshToken, expiresAt, userId })
  } catch {
    throw new CloudAuthSignInRequiredError()
  }
  if (restored === null || restored.session.userId !== account.cloudUserId) {
    throw new CloudAuthSignInRequiredError()
  }
  // Best-effort rotation persistence: the fresh token is usable for
  // this call even if the cache write below fails.
  const freshAccessToken = restored.session.accessToken
  try {
    const provider: StarkAuthProvider | null =
      account.provider === 'google' || account.provider === 'github' ? account.provider : null
    if (provider === null) {
      throw new CloudAuthSignInRequiredError()
    }
    const sealed = await deps.protector.seal(restored.session)
    deps.repository.saveAccountAndSession({
      identity: {
        cloudUserId: account.cloudUserId,
        provider,
        email: account.email,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl
      },
      encryptedSession: sealed,
      expiresAt: normalizeExpiresAtMs(restored.session.expiresAt),
      now: now()
    })
  } catch (error) {
    if (error instanceof CloudAuthSecureStorageUnavailableError) {
      throw error
    }
    if (error instanceof CloudAuthSignInRequiredError) {
      throw error
    }
    // Cache-write failure must not fail a call holding a fresh
    // token; the next call simply refreshes again.
  }
  return freshAccessToken
}

/** Mirrors the service normalization: seconds → ms, ms pass through. */
function normalizeExpiresAtMs(expiresAt: number | null): number | null {
  if (expiresAt === null) {
    return null
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return null
  }
  if (expiresAt < 1_000_000_000_000) {
    return expiresAt * 1000
  }
  return expiresAt
}
