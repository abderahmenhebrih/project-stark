import type { LocalProfile } from '../../shared/profile/types'
import { CorruptProfileError, InvalidDisplayNameError } from './errors'

/**
 * Profile schema: storage key and display-name validation.
 *
 * A display name is free-form Unicode text, not a username: no ASCII
 * restriction and no login-style rules. Validation only guarantees the
 * name is present, bounded, and printable. Character checks use explicit
 * code points (never invisible literals or control escapes) so the rules
 * stay readable and lint-clean.
 */

/** Internal persistence key. Never exposed to the renderer. */
export const PROFILE_STORAGE_KEY = 'stark.profile'

/** Maximum display-name length, counted in Unicode code points. */
export const DISPLAY_NAME_MAX_LENGTH = 40

/** Invisible format characters treated like whitespace for visibility checks. */
const INVISIBLE_CODE_POINTS: readonly number[] = [
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0xfeff, // byte-order mark
  0x00ad // soft hyphen
]

function isControlCodePoint(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

function isInvisibleChar(char: string): boolean {
  if (/\s/.test(char)) {
    return true
  }
  const code = char.codePointAt(0) ?? 0
  return INVISIBLE_CODE_POINTS.includes(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Deep copy so stored objects are never handed out by reference. */
export function cloneProfile(profile: LocalProfile): LocalProfile {
  return { displayName: profile.displayName }
}

/**
 * Validates and normalizes a display-name payload. Returns the trimmed
 * name; internal spacing is preserved exactly.
 */
export function parseDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidDisplayNameError('display name must be a string')
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new InvalidDisplayNameError('display name must not be empty')
  }
  if (Array.from(trimmed).length > DISPLAY_NAME_MAX_LENGTH) {
    throw new InvalidDisplayNameError('display name must be 40 characters or fewer')
  }
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0
    if (isControlCodePoint(code)) {
      throw new InvalidDisplayNameError('display name contains unsupported characters')
    }
  }
  let hasVisible = false
  for (const char of trimmed) {
    if (!isInvisibleChar(char)) {
      hasVisible = true
      break
    }
  }
  if (!hasVisible) {
    throw new InvalidDisplayNameError('display name must contain visible characters')
  }
  return trimmed
}

/**
 * Validates persisted profile data. Anything that is not exactly a
 * { displayName } object with a valid name is corrupt — the caller
 * recovers by routing to onboarding, never by crashing or guessing.
 */
export function parseStoredProfile(raw: unknown): LocalProfile {
  if (!isPlainObject(raw) || typeof raw['displayName'] !== 'string') {
    throw new CorruptProfileError()
  }
  try {
    return { displayName: parseDisplayName(raw['displayName']) }
  } catch (error) {
    if (error instanceof InvalidDisplayNameError) {
      throw new CorruptProfileError({ cause: error })
    }
    throw error
  }
}
