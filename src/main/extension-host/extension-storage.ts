import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Bounded extension-owned storage (Step 8, main-side).
 *
 * Directory: `<installRoot>/extension-storage/<safe-identity>/`,
 * files `global-state.json` and `workspace-state.json`, each shaped
 * `{ "version": 1, "values": { "<key>": primitive } }`.
 *
 * Backs `ExtensionContext.globalState` / `workspaceState` (`get`,
 * `update`, `keys`). Workspace state is main-owned under userData —
 * never inside arbitrary project paths. Values are JSON primitives
 * plus flat string arrays only; each file capped at 1 MiB total with
 * atomic writes. Secrets NEVER land here (see secrets policy: no
 * suitable secure primitive in the host → unsupported).
 */

/** Storage format version. */
export const EXTENSION_STORAGE_VERSION = 1

/** Maximum bytes per state file (1 MiB per scope). */
export const EXTENSION_STORAGE_MAX_BYTES = 1024 * 1024

/** Maximum keys per scope. */
export const EXTENSION_STORAGE_MAX_KEYS = 1024

/** Maximum key length. */
export const EXTENSION_STORAGE_MAX_KEY_LENGTH = 256

/** Maximum serialized bytes per value. */
export const EXTENSION_STORAGE_MAX_VALUE_BYTES = 64 * 1024

export type ExtensionStorageScope = 'global' | 'workspace'

export type StoredValue = string | number | boolean | null | readonly string[]

function scopeFile(scope: ExtensionStorageScope): string {
  return scope === 'global' ? 'global-state.json' : 'workspace-state.json'
}

/** Sanitizes an extension id into a single safe directory name. */
export function storageDirName(extensionId: string): string {
  if (typeof extensionId !== 'string' || extensionId === '') {
    throw new Error('Extension id is not valid.')
  }
  const safe = extensionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200)
  if (safe === '' || safe === '.' || safe === '..') {
    throw new Error('Extension id is not valid.')
  }
  return safe
}

function storageDir(installRoot: string, extensionId: string): string {
  return join(installRoot, 'extension-storage', storageDirName(extensionId))
}

function isValidKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key !== '' &&
    key.length <= EXTENSION_STORAGE_MAX_KEY_LENGTH &&
    !key.includes('\0')
  )
}

function isValidValue(value: unknown): value is StoredValue {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === 'string') {
    return value.length <= EXTENSION_STORAGE_MAX_VALUE_BYTES && !value.includes('\0')
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 256 &&
      value.every((entry) => typeof entry === 'string' && entry.length <= 1024 && !entry.includes('\0'))
    )
  }
  return false
}

/** Reads one scope map (defensive: bad file → empty). */
export function readStorageScope(
  installRoot: string,
  extensionId: string,
  scope: ExtensionStorageScope
): Map<string, StoredValue> {
  const empty = new Map<string, StoredValue>()
  if (typeof installRoot !== 'string' || installRoot === '') {
    return empty
  }
  let dir: string
  try {
    dir = storageDir(installRoot, extensionId)
  } catch {
    return empty
  }
  let raw: string
  try {
    const path = join(dir, scopeFile(scope))
    if (statSync(path).size > EXTENSION_STORAGE_MAX_BYTES) {
      return empty
    }
    raw = readFileSync(path, 'utf8')
  } catch {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return empty
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] !== EXTENSION_STORAGE_VERSION) {
    return empty
  }
  const values = record['values']
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return empty
  }
  const result = new Map<string, StoredValue>()
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (result.size >= EXTENSION_STORAGE_MAX_KEYS) {
      break
    }
    if (!isValidKey(key) || !isValidValue(value)) {
      continue
    }
    result.set(key, value === undefined ? null : value)
  }
  return result
}

/** Stores one value (`undefined` deletes the key). Throws on invalid input. */
export function writeStorageValue(
  installRoot: string,
  extensionId: string,
  scope: ExtensionStorageScope,
  key: string,
  value: unknown
): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new Error('Install root is not valid.')
  }
  if (!isValidKey(key)) {
    throw new Error('Storage key is not valid.')
  }
  if (value !== undefined && !isValidValue(value)) {
    throw new Error('Storage value is not valid.')
  }
  const dir = storageDir(installRoot, extensionId)
  const current = readStorageScope(installRoot, extensionId, scope)
  if (value === undefined) {
    current.delete(key)
  } else {
    current.set(key, value === null ? null : (value as StoredValue))
  }
  const values: Record<string, StoredValue> = {}
  let count = 0
  for (const [entryKey, entryValue] of current) {
    if (count >= EXTENSION_STORAGE_MAX_KEYS) {
      break
    }
    if (!isValidKey(entryKey) || !isValidValue(entryValue)) {
      continue
    }
    values[entryKey] = entryValue
    count += 1
  }
  const payload = JSON.stringify({ version: EXTENSION_STORAGE_VERSION, values })
  if (Buffer.byteLength(payload, 'utf8') > EXTENSION_STORAGE_MAX_BYTES) {
    throw new Error('Extension storage exceeds its limit.')
  }
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.state-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, join(dir, scopeFile(scope)))
}
