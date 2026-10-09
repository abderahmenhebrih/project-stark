import type { StarkAuthProvider } from '../../shared/cloud-account/types'
import { CloudAuthCallbackExpiredError, CloudAuthInProgressError } from './cloud-account-errors'
import { MAX_AUTH_ATTEMPT_MS } from './cloud-account-limits'

/** One bounded pending OAuth attempt (ephemeral main-process state). */
export interface OAuthAttempt {
  readonly id: string
  readonly provider: StarkAuthProvider
  readonly createdAt: number
  readonly expiresAt: number
}

/**
 * Single-pending-attempt manager (Stage 29).
 *
 * No polling, no timers, no retries: expiry is lazy (checked on access)
 * plus one UI/main state deadline read. If STARK closes mid-attempt the
 * state dies with the process — the user simply signs in again.
 */
export class OAuthAttemptManager {
  private pending: OAuthAttempt | null = null
  private counter = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Active non-expired attempt, or null (expired attempts clear lazily). */
  getActive(): OAuthAttempt | null {
    if (this.pending === null) {
      return null
    }
    if (this.now() > this.pending.expiresAt) {
      this.pending = null
      return null
    }
    return this.pending
  }

  /** True while a non-expired attempt is pending. */
  hasActive(): boolean {
    return this.getActive() !== null
  }

  /**
   * Starts one bounded attempt. Rejects when another is active —
   * never opens a second browser, never switches providers.
   */
  start(provider: StarkAuthProvider): OAuthAttempt {
    const active = this.getActive()
    if (active !== null) {
      throw new CloudAuthInProgressError()
    }
    this.counter += 1
    const createdAt = this.now()
    const attempt: OAuthAttempt = {
      id: `auth-${String(createdAt)}-${String(this.counter)}`,
      provider,
      createdAt,
      expiresAt: createdAt + MAX_AUTH_ATTEMPT_MS
    }
    this.pending = attempt
    return attempt
  }

  /**
   * Consumes the active attempt BEFORE any token exchange. The second
   * delivery for the same attempt then sees no pending attempt and
   * must not exchange again (single-use callbacks).
   */
  consumeActive(): OAuthAttempt | null {
    const active = this.getActive()
    this.pending = null
    return active
  }

  /** Returns the active attempt when it matches the expected id, else null. */
  consumeIfIdMatches(id: string): OAuthAttempt | null {
    const active = this.getActive()
    if (active === null || active.id !== id) {
      return null
    }
    this.pending = null
    return active
  }

  /** Explicit Cancel sign-in: clears pending state, no network required. */
  cancel(): boolean {
    const had = this.getActive() !== null
    this.pending = null
    return had
  }

  /**
   * Requires the active attempt or throws: expired attempts clear and
   * throw callback-expired; absent attempts throw callback-expired
   * only when the caller proves expiry, else the caller maps to
   * callback-invalid. This helper throws expired for the expired case.
   */
  requireActiveOrThrowExpired(): OAuthAttempt {
    if (this.pending !== null && this.now() > this.pending.expiresAt) {
      this.pending = null
      throw new CloudAuthCallbackExpiredError()
    }
    const active = this.pending
    if (active === null) {
      throw new CloudAuthCallbackExpiredError()
    }
    return active
  }
}
