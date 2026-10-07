import { DEFAULT_SETTINGS } from '../../shared/settings/constants'
import type { AppearanceMode, StarkSettings } from '../../shared/settings/types'
import { CorruptSettingsError, InvalidSettingsError } from './errors'

/**
 * Settings schema: storage key, defaults handling, and runtime validation.
 *
 * Reads are lenient (unknown stored fields are ignored so newer data does
 * not break older readers; missing fields fall back to defaults), while
 * writes are strict (unknown update keys are rejected). TypeScript types
 * alone cannot enforce IPC payloads, so every boundary revalidates.
 */

/** Internal persistence key. Never exposed to the renderer. */
export const SETTINGS_STORAGE_KEY = 'stark.settings'

const KNOWN_SETTINGS_KEYS: readonly (keyof StarkSettings)[] = [
  'appearance',
  'reduceMotion',
  'confirmBeforeDestructiveActions'
]

/** Deep copy so canonical defaults are never handed out by reference. */
export function cloneSettings(settings: StarkSettings): StarkSettings {
  return JSON.parse(JSON.stringify(settings)) as StarkSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseAppearance(value: unknown): AppearanceMode {
  if (value === 'dark' || value === 'system') {
    return value
  }
  throw new InvalidSettingsError("appearance must be 'dark' or 'system'")
}

function parseBooleanField(field: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  throw new InvalidSettingsError(`${field} must be a boolean`)
}

/**
 * Validates stored settings. Unknown fields are ignored (forward
 * compatibility); known fields with invalid values fail loudly.
 */
export function parseStoredSettings(raw: unknown): StarkSettings {
  if (!isPlainObject(raw)) {
    throw new CorruptSettingsError()
  }
  try {
    return {
      appearance: raw['appearance'] === undefined ? DEFAULT_SETTINGS.appearance : parseAppearance(raw['appearance']),
      reduceMotion:
        raw['reduceMotion'] === undefined
          ? DEFAULT_SETTINGS.reduceMotion
          : parseBooleanField('reduceMotion', raw['reduceMotion']),
      confirmBeforeDestructiveActions:
        raw['confirmBeforeDestructiveActions'] === undefined
          ? DEFAULT_SETTINGS.confirmBeforeDestructiveActions
          : parseBooleanField('confirmBeforeDestructiveActions', raw['confirmBeforeDestructiveActions'])
    }
  } catch (error) {
    if (error instanceof InvalidSettingsError) {
      throw new CorruptSettingsError({ cause: error })
    }
    throw error
  }
}

/**
 * Validates an update payload. The payload must be a plain object
 * containing only known settings fields with valid values.
 */
export function parseUpdatePatch(raw: unknown): Partial<StarkSettings> {
  if (!isPlainObject(raw)) {
    throw new InvalidSettingsError('update must be an object')
  }
  const patch: {
    appearance?: AppearanceMode
    reduceMotion?: boolean
    confirmBeforeDestructiveActions?: boolean
  } = {}
  for (const key of Object.keys(raw)) {
    if (!(KNOWN_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new InvalidSettingsError(`unknown settings field '${key}'`)
    }
    if (key === 'appearance') {
      patch.appearance = parseAppearance(raw[key])
    } else if (key === 'reduceMotion') {
      patch.reduceMotion = parseBooleanField('reduceMotion', raw[key])
    } else {
      patch.confirmBeforeDestructiveActions = parseBooleanField(
        'confirmBeforeDestructiveActions',
        raw[key]
      )
    }
  }
  return patch
}
