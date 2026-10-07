import { DEFAULT_SETTINGS } from '../../shared/settings/constants'
import type { StarkSettings } from '../../shared/settings/types'
import { CorruptValueError } from '../database/errors'
import { assertJsonValue } from '../database/json'
import type { KeyValueRepository } from '../database/repositories/key-value-repository'
import { CorruptSettingsError } from './errors'
import { cloneSettings, parseStoredSettings, parseUpdatePatch, SETTINGS_STORAGE_KEY } from './settings-schema'

/**
 * Settings domain service: the only main-process gateway to persisted
 * settings. Owns validation, defaults, and the storage mapping; owns no
 * SQLite connection (the repository is injected).
 *
 * Async at the boundary on purpose: callers (IPC today) must not depend
 * on the repository being synchronous.
 */
export class SettingsService {
  constructor(private readonly repository: KeyValueRepository) {}

  /** Complete settings; canonical defaults when nothing is stored yet. */
  async getSettings(): Promise<StarkSettings> {
    let stored: unknown
    try {
      stored = this.repository.get(SETTINGS_STORAGE_KEY)
    } catch (error) {
      if (error instanceof CorruptValueError) {
        throw new CorruptSettingsError({ cause: error })
      }
      throw error
    }
    if (stored === undefined) {
      return cloneSettings(DEFAULT_SETTINGS)
    }
    return cloneSettings(parseStoredSettings(stored))
  }

  /**
   * Merges a strictly validated patch over current settings and persists
   * the complete result. Unknown fields or mistyped values throw
   * InvalidSettingsError before anything is written.
   */
  async updateSettings(rawPatch: unknown): Promise<StarkSettings> {
    const patch = parseUpdatePatch(rawPatch)
    const current = await this.getSettings()
    const merged = parseStoredSettings({ ...current, ...patch })
    assertJsonValue(merged, 'settings')
    this.repository.set(SETTINGS_STORAGE_KEY, merged)
    return cloneSettings(merged)
  }

  /**
   * Restores canonical defaults. Strategy: persist the defaults (rather
   * than deleting the record) so the stored state after a reset is always
   * explicit, deterministic, and auditable.
   */
  async resetSettings(): Promise<StarkSettings> {
    const defaults = cloneSettings(DEFAULT_SETTINGS)
    assertJsonValue(defaults, 'default settings')
    this.repository.set(SETTINGS_STORAGE_KEY, defaults)
    return cloneSettings(defaults)
  }
}
