import type {
  CloudAccountStatus,
  SafeCloudAccount,
  StarkAuthProvider,
  StartSignInResult
} from '../../shared/cloud-account/types'
import { CloudAccountRepository, type StoredCloudAccount } from './cloud-account-repository'
import {
  CloudAuthCallbackExpiredError,
  CloudAuthCallbackInvalidError,
  CloudAuthExchangeFailedError,
  CloudAuthInProgressError,
  CloudAuthInvalidProviderError,
  CloudAuthSaveFailedError,
  CloudAuthSecureStorageUnavailableError,
  CloudAuthSignOutFailedError,
  CloudAuthUnavailableError
} from './cloud-account-errors'
import type {
  AccountStatusEmitter,
  AuthenticatedIdentity,
  BrowserOpener,
  CloudAuthAdapter,
  NormalizedCloudIdentity
} from './cloud-account-types'
import { validateSessionEnvelope, SessionProtector } from './cloud-auth-session-store'
import { MAX_AUTH_ATTEMPT_MS } from './cloud-account-limits'
import { OAuthAttemptManager } from './oauth-attempt-manager'
import { parseAuthCallbackUrl } from './deep-link'

function isAuthProvider(value: unknown): value is StarkAuthProvider {
  return value === 'google' || value === 'github'
}

function toSafeAccount(stored: StoredCloudAccount): SafeCloudAccount {
  const provider: StarkAuthProvider = stored.provider === 'github' ? 'github' : 'google'
  return {
    provider,
    email: stored.email,
    displayName: stored.displayName,
    avatarUrl: stored.avatarUrl
  }
}

function toSafeAccountFromIdentity(identity: NormalizedCloudIdentity): SafeCloudAccount {
  return {
    provider: identity.provider,
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl
  }
}

function normalizeExpiresAtMs(expiresAt: number | null): number | null {
  if (expiresAt === null) {
    return null
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    return null
  }
  // Supabase reports seconds; fakes/tests use milliseconds. Heuristic:
  // values below 1e12 are seconds.
  if (expiresAt < 1_000_000_000_000) {
    return expiresAt * 1000
  }
  return expiresAt
}

export interface CloudAccountServiceDeps {
  readonly repository: CloudAccountRepository
  readonly sessionProtector: SessionProtector
  readonly authAdapter: CloudAuthAdapter
  readonly attempts: OAuthAttemptManager
  readonly browserOpener: BrowserOpener
  readonly now?: () => number
  readonly emit?: AccountStatusEmitter
}

/**
 * Dedicated STARK cloud-account service (Stage 29).
 *
 * Owns Google/GitHub OAuth orchestration, encrypted session
 * persistence, and safe status derivation. Imports ONLY the auth
 * adapter, safeStorage wrapper, repository, opener, and deep-link
 * helpers — never Workspace, session, transaction, worker, runtime,
 * usage, or AI provider modules (see architecture tests).
 *
 * Local-first: every failure degrades to a safe local status; local
 * Workspaces/sessions/keys are never touched.
 */
export class CloudAccountService {
  private readonly repository: CloudAccountRepository
  private readonly sessionProtector: SessionProtector
  private readonly authAdapter: CloudAuthAdapter
  private readonly attempts: OAuthAttemptManager
  private readonly browserOpener: BrowserOpener
  private readonly now: () => number
  private emit: AccountStatusEmitter | undefined

  constructor(deps: CloudAccountServiceDeps) {
    this.repository = deps.repository
    this.sessionProtector = deps.sessionProtector
    this.authAdapter = deps.authAdapter
    this.attempts = deps.attempts
    this.browserOpener = deps.browserOpener
    this.now = deps.now ?? Date.now
    this.emit = deps.emit
  }

  /** Wires the main→renderer status broadcast after construction (app root only). */
  setEmitter(emitter: AccountStatusEmitter | undefined): void {
    this.emit = emitter
  }

  /** Renderer-safe status. Never throws with secrets; never blocks. */
  getStatus(): CloudAccountStatus {
    try {
      if (!this.authAdapter.isConfigured()) {
        return { state: 'unavailable' }
      }
      const active = this.attempts.getActive()
      if (active !== null) {
        return { state: 'signing_in', provider: active.provider }
      }
      const stored = this.repository.findAccount()
      if (stored === undefined) {
        return { state: 'signed_out' }
      }
      const session = this.safeFindSession()
      if (session === undefined) {
        return { state: 'session_attention', account: toSafeAccount(stored), reason: 'invalid' }
      }
      if (session.expiresAt !== null && this.now() > session.expiresAt) {
        return { state: 'session_attention', account: toSafeAccount(stored), reason: 'expired' }
      }
      return { state: 'signed_in', account: toSafeAccount(stored) }
    } catch {
      try {
        if (!this.authAdapter.isConfigured()) {
          return { state: 'unavailable' }
        }
      } catch {
        return { state: 'unavailable' }
      }
      return { state: 'signed_out' }
    }
  }

  /**
   * Starts one bounded OAuth attempt: validates provider, config, and
   * single-flight; asks the adapter for the authorization URL;
   * opens the SYSTEM browser exactly once.
   */
  async startSignIn(rawProvider: unknown): Promise<StartSignInResult> {
    if (!isAuthProvider(rawProvider)) {
      throw new CloudAuthInvalidProviderError()
    }
    const provider = rawProvider
    if (!this.authAdapter.isConfigured()) {
      throw new CloudAuthUnavailableError()
    }
    let existing: StoredCloudAccount | undefined
    try {
      existing = this.repository.findAccount()
    } catch (error) {
      throw new CloudAuthSaveFailedError({ cause: error })
    }
    if (existing !== undefined) {
      throw new CloudAuthInProgressError()
    }
    try {
      this.attempts.start(provider)
    } catch (error) {
      throw error instanceof CloudAuthInProgressError ? error : new CloudAuthInProgressError()
    }
    let url: string
    try {
      const outcome = await this.authAdapter.beginOAuth(provider)
      url = outcome.url
      if (typeof url !== 'string' || url === '') {
        throw new CloudAuthExchangeFailedError()
      }
    } catch (error) {
      this.attempts.cancel()
      this.emitStatus()
      if (
        error instanceof CloudAuthInProgressError ||
        error instanceof CloudAuthInvalidProviderError ||
        error instanceof CloudAuthUnavailableError
      ) {
        throw error
      }
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
    try {
      await this.browserOpener(url)
    } catch (error) {
      this.attempts.cancel()
      this.emitStatus()
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
    // Safe status transition only — never URL/params in logs.
    this.emitStatus()
    return { outcome: 'browser_opened', provider }
  }

  /** Explicit Cancel sign-in: clears pending state, no network. */
  async cancelSignIn(): Promise<CloudAccountStatus> {
    this.attempts.cancel()
    const status = this.getStatus()
    this.emitStatus(status)
    return status
  }

  /**
   * Handles one Electron-main deep-link callback. NOT reachable from
   * renderer IPC. Consumes the pending attempt BEFORE exchanging so a
   * replayed callback can never exchange twice.
   */
  async handleAuthCallback(rawUrl: string): Promise<CloudAccountStatus> {
    const active = this.attempts.getActive()
    if (active === null) {
      // Distinguish expired-vs-absent for safe copy: the manager
      // already cleared lazily-expired attempts.
      throw new CloudAuthCallbackInvalidError()
    }
    if (this.now() > active.expiresAt) {
      this.attempts.cancel()
      this.emitStatus()
      throw new CloudAuthCallbackExpiredError()
    }
    let code: string
    try {
      code = parseAuthCallbackUrl(rawUrl).code
    } catch {
      throw new CloudAuthCallbackInvalidError()
    }
    // Single-use: consume BEFORE the exchange.
    this.attempts.consumeActive()
    let authenticated: AuthenticatedIdentity
    try {
      authenticated = await this.authAdapter.exchangeCode(code)
    } catch (error) {
      this.emitStatus()
      if (
        error instanceof CloudAuthCallbackInvalidError ||
        error instanceof CloudAuthCallbackExpiredError
      ) {
        throw error
      }
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
    // Re-stamp the attempt provider: the adapter seam cannot always
    // infer it from the SDK session, but the pending attempt knows it.
    const identity: NormalizedCloudIdentity = { ...authenticated.identity, provider: active.provider }
    try {
      validateSessionEnvelope(authenticated.session)
    } catch (error) {
      this.emitStatus()
      throw new CloudAuthExchangeFailedError({ cause: error })
    }
    let sealed: Buffer
    try {
      sealed = await this.sessionProtector.seal(authenticated.session)
    } catch (error) {
      if (error instanceof CloudAuthSecureStorageUnavailableError) {
        try {
          await this.authAdapter.signOut()
        } catch {
          // Best effort revoke; the safe state below is what matters.
        }
        this.emitStatus()
        throw error
      }
      this.emitStatus()
      throw new CloudAuthSecureStorageUnavailableError()
    }
    const now = this.now()
    const expiresAt = normalizeExpiresAtMs(authenticated.session.expiresAt)
    try {
      this.repository.saveAccountAndSession({ identity, encryptedSession: sealed, expiresAt, now })
    } catch (error) {
      try {
        await this.authAdapter.signOut()
      } catch {
        // Best effort: persistence failure state below is authoritative.
      }
      this.emitStatus()
      throw new CloudAuthSaveFailedError({ cause: error })
    }
    // Optional single bounded own-profile upsert. Non-fatal: login
    // stays valid when the table is absent or the call fails.
    try {
      await this.authAdapter.upsertOwnProfile(identity)
    } catch {
      // Non-fatal by design — no retry.
    }
    const status: CloudAccountStatus = { state: 'signed_in', account: toSafeAccountFromIdentity(identity) }
    this.emitStatus(status)
    return status
  }

  /**
   * Explicit Sign out: clears local identity + encrypted session
   * atomically, clears the SDK session, and attempts one bounded
   * remote revoke. Local clear never depends on network success and
   * never deletes Workspaces/sessions/keys.
   */
  async signOut(): Promise<CloudAccountStatus> {
    this.attempts.cancel()
    try {
      this.repository.clearAccountAndSession()
    } catch (error) {
      throw new CloudAuthSignOutFailedError({ cause: error })
    }
    try {
      await this.authAdapter.signOut()
    } catch {
      // Remote revoke failure is non-fatal: local sign-out already won.
    }
    const status = this.getStatus()
    this.emitStatus(status)
    return status
  }

  /**
   * One bounded startup restore: decrypts the persisted envelope and
   * restores the SDK session locally. Never opens a browser, never
   * polls, never blocks window creation. At most one SDK refresh
   * happens inside the adapter when needed.
   */
  async restoreAtStartup(): Promise<CloudAccountStatus> {
    try {
      if (!this.authAdapter.isConfigured()) {
        return { state: 'unavailable' }
      }
      const stored = this.repository.findAccount()
      const sessionRow = this.safeFindSession()
      if (stored === undefined || sessionRow === undefined) {
        return this.getStatus()
      }
      let envelope
      try {
        envelope = await this.sessionProtector.open(sessionRow.encryptedSession)
      } catch {
        return { state: 'session_attention', account: toSafeAccount(stored), reason: 'invalid' }
      }
      // Offline-safe: a network failure keeps the cached signed-in
      // status with no retry loop and no local data deletion.
      let restored: AuthenticatedIdentity | null
      try {
        restored = await this.authAdapter.restoreSession(envelope)
      } catch {
        return { state: 'signed_in', account: toSafeAccount(stored) }
      }
      if (restored === null) {
        const expiresAt = normalizeExpiresAtMs(envelope.expiresAt)
        if (expiresAt !== null && this.now() > expiresAt) {
          return { state: 'session_attention', account: toSafeAccount(stored), reason: 'expired' }
        }
        return { state: 'session_attention', account: toSafeAccount(stored), reason: 'invalid' }
      }
      return { state: 'signed_in', account: toSafeAccount(stored) }
    } catch {
      return { state: 'signed_out' }
    }
  }

  private safeFindSession(): { encryptedSession: Buffer; expiresAt: number | null } | undefined {
    try {
      return this.repository.findEncryptedSession()
    } catch {
      return undefined
    }
  }

  private emitStatus(explicit?: CloudAccountStatus): void {
    if (this.emit === undefined) {
      return
    }
    try {
      this.emit(explicit ?? this.getStatus())
    } catch {
      // Emitter failures must never break auth flows.
    }
  }
}

/** Maximum OAuth attempt lifetime, re-exported for tests/wiring. */
export const CLOUD_AUTH_ATTEMPT_WINDOW_MS = MAX_AUTH_ATTEMPT_MS
