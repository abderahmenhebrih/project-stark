import type { LocalProfile } from '../../shared/profile/types'
import { CorruptValueError } from '../database/errors'
import { assertJsonValue } from '../database/json'
import type { KeyValueRepository } from '../database/repositories/key-value-repository'
import { CorruptProfileError } from './errors'
import { cloneProfile, parseDisplayName, parseStoredProfile, PROFILE_STORAGE_KEY } from './profile-schema'

/**
 * Profile domain service: the only main-process gateway to the local
 * profile. Owns validation, normalization, and the storage mapping;
 * owns no SQLite connection (the repository is injected).
 *
 * Recovery rule: corrupt persisted data is never fatal. getProfile()
 * treats it as "no profile" (with a payload-free diagnostic warn) so
 * the renderer routes to onboarding, where the user can simply set a
 * new name. Infra failures still propagate.
 *
 * Async at the boundary on purpose: callers (IPC today) must not depend
 * on the repository being synchronous.
 */
export class ProfileService {
  constructor(private readonly repository: KeyValueRepository) {}

  /** Stored profile, or null when absent or unrecoverably malformed. */
  async getProfile(): Promise<LocalProfile | null> {
    let stored: unknown
    try {
      stored = this.repository.get(PROFILE_STORAGE_KEY)
    } catch (error) {
      if (error instanceof CorruptValueError) {
        console.warn('[STARK] stored profile is invalid; routing to onboarding')
        return null
      }
      throw error
    }
    if (stored === undefined) {
      return null
    }
    try {
      return cloneProfile(parseStoredProfile(stored))
    } catch (error) {
      if (error instanceof CorruptProfileError) {
        console.warn('[STARK] stored profile is invalid; routing to onboarding')
        return null
      }
      throw error
    }
  }

  /**
   * Validates, trims, and persists a display name. Anything failing
   * validation throws InvalidDisplayNameError before anything is written.
   */
  async setDisplayName(rawName: unknown): Promise<LocalProfile> {
    const profile = { displayName: parseDisplayName(rawName) }
    assertJsonValue(profile, 'profile')
    this.repository.set(PROFILE_STORAGE_KEY, profile)
    return cloneProfile(profile)
  }

  /** Removes the stored profile. Used by tests and future profile resets. */
  async clearProfile(): Promise<void> {
    this.repository.delete(PROFILE_STORAGE_KEY)
  }
}
