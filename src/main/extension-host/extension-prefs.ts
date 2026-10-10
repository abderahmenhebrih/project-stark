import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Main-owned extension-management preferences (Step 9, no DB migration).
 *
 * File: `<installRoot>/extensions-prefs.json`, shaped
 * `{ "version": 1, "automaticallyUpdateExtensions": false }`.
 *
 * Today this owns exactly one flag: the optional global auto-update
 * policy (DEFAULT OFF — manual updates unless the user opts in).
 * Reads are defensive (bad file → defaults); writes are atomic.
 */

/** Main-owned prefs file name directly under the install root. */
export const EXTENSION_PREFS_FILE_NAME = 'extensions-prefs.json'

/** Prefs file format version. */
export const EXTENSION_PREFS_VERSION = 1

/** Maximum prefs file bytes read. */
export const EXTENSION_PREFS_MAX_BYTES = 4096

export interface SelectedThemeRef {
  readonly extensionId: string
  readonly themeId: string
}

export interface ExtensionPrefs {
  /** Optional auto-update policy. DEFAULT OFF. */
  readonly automaticallyUpdateExtensions: boolean
  /** Selected editor theme (null = STARK default). */
  readonly selectedEditorTheme: SelectedThemeRef | null
  /** Selected Explorer icon theme (null = STARK default). */
  readonly selectedIconTheme: SelectedThemeRef | null
}

export function defaultExtensionPrefs(): ExtensionPrefs {
  return { automaticallyUpdateExtensions: false, selectedEditorTheme: null, selectedIconTheme: null }
}

function readThemeRef(value: unknown): SelectedThemeRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record['extensionId'] !== 'string' || typeof record['themeId'] !== 'string') {
    return null
  }
  if (record['extensionId'] === '' || record['extensionId'].length > 321 || record['themeId'] === '' || record['themeId'].length > 256) {
    return null
  }
  return { extensionId: record['extensionId'], themeId: record['themeId'] }
}

/** Reads prefs (defensive: bad file → defaults). */
export function readExtensionPrefs(installRoot: string): ExtensionPrefs {
  if (typeof installRoot !== 'string' || installRoot === '') {
    return defaultExtensionPrefs()
  }
  let raw: string
  try {
    const path = join(installRoot, EXTENSION_PREFS_FILE_NAME)
    if (statSync(path).size > EXTENSION_PREFS_MAX_BYTES) {
      return defaultExtensionPrefs()
    }
    raw = readFileSync(path, 'utf8')
  } catch {
    return defaultExtensionPrefs()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return defaultExtensionPrefs()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaultExtensionPrefs()
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] !== EXTENSION_PREFS_VERSION) {
    return defaultExtensionPrefs()
  }
  return {
    automaticallyUpdateExtensions: record['automaticallyUpdateExtensions'] === true,
    selectedEditorTheme: readThemeRef(record['selectedEditorTheme']),
    selectedIconTheme: readThemeRef(record['selectedIconTheme'])
  }
}

/** Persists the auto-update flag (validated boolean only). */
export function writeExtensionPrefs(installRoot: string, prefs: ExtensionPrefs): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new Error('Install root is not valid.')
  }
  if (typeof prefs.automaticallyUpdateExtensions !== 'boolean') {
    throw new Error('Preferences are not valid.')
  }
  const selectedEditorTheme = prefs.selectedEditorTheme === null ? null : readThemeRef(prefs.selectedEditorTheme)
  const selectedIconTheme = prefs.selectedIconTheme === null ? null : readThemeRef(prefs.selectedIconTheme)
  if ((prefs.selectedEditorTheme !== null && selectedEditorTheme === null) || (prefs.selectedIconTheme !== null && selectedIconTheme === null)) {
    throw new Error('Preferences are not valid.')
  }
  const payload = JSON.stringify(
    {
      version: EXTENSION_PREFS_VERSION,
      automaticallyUpdateExtensions: prefs.automaticallyUpdateExtensions,
      selectedEditorTheme,
      selectedIconTheme
    },
    null,
    2
  )
  mkdirSync(installRoot, { recursive: true })
  const tmpPath = join(installRoot, `.extensions-prefs-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, join(installRoot, EXTENSION_PREFS_FILE_NAME))
}
