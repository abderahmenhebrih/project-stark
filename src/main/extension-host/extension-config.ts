import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Main-owned extension configuration store (Step 8, no DB migration).
 *
 * File: `<installRoot>/extensions-config.json`, shaped
 * `{ "version": 1, "extensions": { "<extensionId>": { "<section.key>": primitive } } }`.
 *
 * Backs `workspace.getConfiguration(section)` reads and the
 * `.update()` path: extensions never write VS Code settings files —
 * values land here through the narrow config IPC. Only JSON
 * primitives (string/number/boolean/null) plus flat string arrays are
 * stored; objects, functions, and overlong values are rejected.
 *
 * Bounds: 64 KiB file cap, 512 extensions, 256 keys per extension,
 * 2 KiB per value. Reads are defensive (bad file → empty); writes are
 * atomic (temp file + rename).
 */

/** Main-owned config file name directly under the install root. */
export const EXTENSION_CONFIG_FILE_NAME = 'extensions-config.json'

/** Config file format version. */
export const EXTENSION_CONFIG_VERSION = 1

/** Maximum config file bytes read. */
export const EXTENSION_CONFIG_MAX_BYTES = 256 * 1024

/** Maximum extensions with stored config. */
export const EXTENSION_CONFIG_MAX_EXTENSIONS = 512

/** Maximum keys stored per extension. */
export const EXTENSION_CONFIG_MAX_KEYS_PER_EXTENSION = 256

/** Maximum serialized bytes per value. */
export const EXTENSION_CONFIG_MAX_VALUE_BYTES = 2048

/** Maximum key length (`section.name` form). */
export const EXTENSION_CONFIG_MAX_KEY_LENGTH = 256

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/
const KEY_PART = /^[A-Za-z0-9_-]+$/

export type ExtensionConfigValue = string | number | boolean | null | readonly string[]

export function isValidConfigKey(key: string): boolean {
  if (typeof key !== 'string' || key === '' || key.length > EXTENSION_CONFIG_MAX_KEY_LENGTH || key.includes('\0')) {
    return false
  }
  const parts = key.split('.')
  if (parts.length < 1 || parts.length > 4) {
    return false
  }
  return parts.every((part) => part !== '' && KEY_PART.test(part))
}

export function isValidConfigValue(value: unknown): value is ExtensionConfigValue {
  if (value === null) {
    return true
  }
  if (typeof value === 'string') {
    return value.length <= EXTENSION_CONFIG_MAX_VALUE_BYTES && !value.includes('\0')
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      return false
    }
    return value.every((entry) => typeof entry === 'string' && entry.length <= 256 && !entry.includes('\0'))
  }
  return false
}

function configFilePath(installRoot: string): string {
  return join(installRoot, EXTENSION_CONFIG_FILE_NAME)
}

export type ExtensionConfigMap = Map<string, Map<string, ExtensionConfigValue>>

/** Reads all stored extension config (defensive: bad file → empty). */
export function readExtensionConfigs(installRoot: string): ExtensionConfigMap {
  const empty: ExtensionConfigMap = new Map()
  if (typeof installRoot !== 'string' || installRoot === '') {
    return empty
  }
  let raw: string
  try {
    const path = configFilePath(installRoot)
    if (statSync(path).size > EXTENSION_CONFIG_MAX_BYTES) {
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
  if (record['version'] !== EXTENSION_CONFIG_VERSION) {
    return empty
  }
  const extensions = record['extensions']
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) {
    return empty
  }
  const result: ExtensionConfigMap = new Map()
  for (const [extensionId, values] of Object.entries(extensions as Record<string, unknown>)) {
    if (result.size >= EXTENSION_CONFIG_MAX_EXTENSIONS) {
      break
    }
    if (typeof extensionId !== 'string' || extensionId.length > 321 || !EXTENSION_ID.test(extensionId)) {
      continue
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      continue
    }
    const inner = new Map<string, ExtensionConfigValue>()
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (inner.size >= EXTENSION_CONFIG_MAX_KEYS_PER_EXTENSION) {
        break
      }
      if (!isValidConfigKey(key) || !isValidConfigValue(value)) {
        continue
      }
      inner.set(key, value)
    }
    if (inner.size > 0) {
      result.set(extensionId, inner)
    }
  }
  return result
}

/**
 * Reads one config value (`section` + optional `key` joined with `.`),
 * falling back to `dflt` when absent. Pure over an already-read map.
 */
export function getExtensionConfigValue<T>(
  configs: ExtensionConfigMap,
  extensionId: string,
  section: string,
  key: string | null,
  dflt: T
): ExtensionConfigValue | T {
  const inner = configs.get(extensionId)
  if (inner === undefined) {
    return dflt
  }
  const fullKey = key === null || key === '' ? section : `${section}.${key}`
  const value = inner.get(fullKey)
  return value === undefined ? dflt : value
}

/**
 * Stores one config value (validated primitive only). Throws on
 * invalid key/value or filesystem failure.
 */
export function writeExtensionConfigValue(
  installRoot: string,
  extensionId: string,
  key: string,
  value: unknown
): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new Error('Install root is not valid.')
  }
  if (typeof extensionId !== 'string' || extensionId.length > 321 || !EXTENSION_ID.test(extensionId)) {
    throw new Error('Extension id is not valid.')
  }
  if (!isValidConfigKey(key)) {
    throw new Error('Configuration key is not valid.')
  }
  if (!isValidConfigValue(value)) {
    throw new Error('Configuration value is not valid.')
  }
  const configs = readExtensionConfigs(installRoot)
  let inner = configs.get(extensionId)
  if (inner === undefined) {
    inner = new Map()
    configs.set(extensionId, inner)
  }
  inner.set(key, value)
  persistConfigs(installRoot, configs)
}

/** Removes all stored config for one extension (best-effort cleanup on uninstall). */
export function clearExtensionConfig(installRoot: string, extensionId: string): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    return
  }
  const configs = readExtensionConfigs(installRoot)
  if (!configs.has(extensionId)) {
    return
  }
  configs.delete(extensionId)
  try {
    persistConfigs(installRoot, configs)
  } catch {
    // Best effort cleanup.
  }
}

function persistConfigs(installRoot: string, configs: ExtensionConfigMap): void {
  const extensions: Record<string, Record<string, ExtensionConfigValue>> = {}
  let extCount = 0
  for (const [extensionId, inner] of configs) {
    if (extCount >= EXTENSION_CONFIG_MAX_EXTENSIONS) {
      break
    }
    if (typeof extensionId !== 'string' || !EXTENSION_ID.test(extensionId)) {
      continue
    }
    const values: Record<string, ExtensionConfigValue> = {}
    let keyCount = 0
    for (const [key, value] of inner) {
      if (keyCount >= EXTENSION_CONFIG_MAX_KEYS_PER_EXTENSION) {
        break
      }
      if (!isValidConfigKey(key) || !isValidConfigValue(value)) {
        continue
      }
      values[key] = value
      keyCount += 1
    }
    extensions[extensionId] = values
    extCount += 1
  }
  const payload = JSON.stringify({ version: EXTENSION_CONFIG_VERSION, extensions })
  if (Buffer.byteLength(payload, 'utf8') > EXTENSION_CONFIG_MAX_BYTES) {
    throw new Error('Extension configuration exceeds its limit.')
  }
  mkdirSync(installRoot, { recursive: true })
  const tmpPath = join(installRoot, `.extensions-config-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, configFilePath(installRoot))
}
