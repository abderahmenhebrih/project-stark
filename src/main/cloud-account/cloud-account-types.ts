import type { StarkAuthProvider } from '../../shared/cloud-account/types'

/**
 * Main-process-only cloud-account types (Stage 29).
 *
 * Normalized identities and session envelopes are the ONLY auth
 * material the service handles. Raw Supabase Session/User objects
 * never leave the auth adapter.
 */

/** Normalized cloud identity persisted locally (id=1 singleton). */
export interface NormalizedCloudIdentity {
  readonly cloudUserId: string
  readonly provider: StarkAuthProvider
  readonly email: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
}

/**
 * Minimum normalized session material the Supabase SDK needs to
 * restore/refresh authentication. Encrypted as one envelope — never
 * plaintext in SQLite, logs, or IPC.
 */
export interface CloudSessionEnvelope {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number | null
  readonly userId: string
}

/** Identity returned alongside a freshly exchanged/restored session. */
export interface AuthenticatedIdentity {
  readonly identity: NormalizedCloudIdentity
  readonly session: CloudSessionEnvelope
}

/**
 * Narrow auth-adapter seam so tests never need network.
 * Production uses the Supabase adapter; tests inject fakes.
 * Single attempt per call, bounded timeouts, zero retries.
 */
export interface CloudAuthAdapter {
  /** False when Supabase public config is absent. */
  isConfigured(): boolean
  /** Builds the provider OAuth authorization URL (no browser here). */
  beginOAuth(provider: StarkAuthProvider): Promise<{ url: string }>
  /** Exchanges one authorization code exactly once. */
  exchangeCode(code: string): Promise<AuthenticatedIdentity>
  /**
   * Restores a persisted envelope (at most one SDK refresh inside
   * when the token is expired). Returns null when the session is no
   * longer usable. Single attempt, no retry loop.
   */
  restoreSession(session: CloudSessionEnvelope): Promise<AuthenticatedIdentity | null>
  /** Clears the SDK-local session; best effort, single attempt. */
  signOut(): Promise<void>
  /**
   * Optional single bounded own-profile upsert after sign-in.
   * Non-fatal: failures must not invalidate the login.
   */
  upsertOwnProfile(identity: NormalizedCloudIdentity): Promise<void>
}

/** Opens the system browser exactly once per OAuth attempt. */
export type BrowserOpener = (url: string) => Promise<void>

/** Emits safe account-status updates to renderers. */
export type AccountStatusEmitter = (status: import('../../shared/cloud-account/types').CloudAccountStatus) => void
