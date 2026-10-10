import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ValidatedInstallIdentity } from './extension-install-service'

/**
 * Main-owned installed-extension management state (enabled flags
 * only — store layout, packages, and hashes stay in stark-install.json
 * and the installer service).
 *
 * Single file, main-owned path only:
 * `<installRoot>/extensions-state.json`, shaped
 * `{ "version": 1, "extensions": { "<ns>.<name>@<version>": { "enabled": true } } }`.
 * The renderer never chooses the path, never writes the file, and
 * never merges JSON: it sends identity + flag through the narrow
 * setEnabled IPC and receives normalized entries back.
 *
 * Safety properties:
 * - reads are bounded (64 KiB) and defensive: missing, oversize, or
 *   malformed files read back as an empty map — installed packages
 *   are never deleted because the state file is bad (callers default
 *   missing entries to enabled=true);
 * - writes go through a temp file + atomic rename under the same
 *   main-owned directory;
 * - keys are strictly validated (`<ns>.<name>@<version>`, registry
 *   charset only), values are exactly `{ enabled: boolean }` — no
 *   arbitrary JSON merge;
 * - the on-disk package tree is always truth: writers normalize the
 *   map against actually-installed identities (drop ghosts, default
 *   newcomers to true), so the state file can never invent packages.
 */

/** Main-owned state file name directly under the install root. */
export const EXTENSION_STATE_FILE_NAME = 'extensions-state.json'

/** State file format version (bump only with a reviewed migration). */
export const EXTENSION_STATE_VERSION = 1

/** Maximum state file bytes read (far above any legitimate store). */
export const EXTENSION_STATE_MAX_BYTES = 64 * 1024

/** Maximum state entries persisted (matches the install list cap). */
export const EXTENSION_STATE_MAX_ENTRIES = 512

const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/

/** Exact-identity state key: `<namespace>.<name>@<version>`. */
export function extensionStateKey(identity: ValidatedInstallIdentity): string {
  return `${identity.namespace}.${identity.name}@${identity.version}`
}

function isValidStateKey(key: string): boolean {
  return key.length <= 321 && STATE_KEY.test(key)
}

function stateFilePath(installRoot: string): string {
  return join(installRoot, EXTENSION_STATE_FILE_NAME)
}

/**
 * Reads the enabled-state map (key → enabled). Never throws for
 * filesystem or content problems: missing, oversize, unparsable, or
 * schema-violating files all read back as an empty map so callers
 * default to enabled=true and writers reconstruct cleanly.
 */
export function readExtensionEnabledStates(installRoot: string): Map<string, boolean> {
  const empty = new Map<string, boolean>()
  if (typeof installRoot !== 'string' || installRoot === '') {
    return empty
  }
  let raw: string
  try {
    const path = stateFilePath(installRoot)
    if (statSync(path).size > EXTENSION_STATE_MAX_BYTES) {
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
  if (record['version'] !== EXTENSION_STATE_VERSION) {
    return empty
  }
  const extensions = record['extensions']
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) {
    return empty
  }
  const result = new Map<string, boolean>()
  for (const [key, value] of Object.entries(extensions as Record<string, unknown>)) {
    if (result.size >= EXTENSION_STATE_MAX_ENTRIES) {
      break
    }
    if (!isValidStateKey(key)) {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const fields = Object.keys(value as Record<string, unknown>)
    if (fields.length !== 1 || fields[0] !== 'enabled') {
      continue
    }
    const enabled = (value as Record<string, unknown>)['enabled']
    if (typeof enabled !== 'boolean') {
      continue
    }
    result.set(key, enabled)
  }
  return result
}

/**
 * Persists the enabled-state map through a temp file + atomic rename.
 * Entries are capped; keys and values are re-validated on the way
 * out so only strict state ever lands on disk. Throws on filesystem
 * failure (callers decide whether the mutation is best-effort).
 */
export function writeExtensionEnabledStates(installRoot: string, states: Map<string, boolean>): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new Error('Install root is not valid.')
  }
  const extensions: Record<string, { enabled: boolean }> = {}
  let count = 0
  for (const [key, enabled] of states) {
    if (count >= EXTENSION_STATE_MAX_ENTRIES) {
      break
    }
    if (!isValidStateKey(key) || typeof enabled !== 'boolean') {
      continue
    }
    extensions[key] = { enabled }
    count += 1
  }
  const payload = JSON.stringify({ version: EXTENSION_STATE_VERSION, extensions }, null, 2)
  mkdirSync(installRoot, { recursive: true })
  const tmpPath = join(installRoot, `.extensions-state-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, stateFilePath(installRoot))
}
