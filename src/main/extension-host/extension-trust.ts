import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ValidatedInstallIdentity } from '../extension-install/extension-install-service'

/**
 * Main-owned extension trust store (Step 8, no DB migration).
 *
 * File: `<installRoot>/extensions-trust.json`, shaped
 * `{ "version": 1, "extensions": { "<ns>.<name>@<version>": { "trusted": true } } }`.
 *
 * Trust is explicit and version-pinned: the key includes the exact
 * version, so a newly installed version NEVER inherits trust from an
 * older one. Missing entries read back as untrusted. The renderer
 * never chooses the path and never writes the file — it sends identity
 * through the narrow trust IPC and receives a normalized boolean.
 *
 * Reads are defensive (missing/oversize/malformed → empty map);
 * writes go through temp file + atomic rename and re-validate keys.
 */

/** Main-owned trust file name directly under the install root. */
export const EXTENSION_TRUST_FILE_NAME = 'extensions-trust.json'

/** Trust file format version (bump only with a reviewed migration). */
export const EXTENSION_TRUST_VERSION = 1

/** Maximum trust file bytes read. */
export const EXTENSION_TRUST_MAX_BYTES = 64 * 1024

/** Maximum trust entries persisted (matches the install list cap). */
export const EXTENSION_TRUST_MAX_ENTRIES = 512

const TRUST_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z._+-]*$/

/** Exact-identity trust key: `<namespace>.<name>@<version>`. */
export function extensionTrustKey(identity: ValidatedInstallIdentity): string {
  return `${identity.namespace}.${identity.name}@${identity.version}`
}

function isValidTrustKey(key: string): boolean {
  return key.length <= 321 && TRUST_KEY.test(key)
}

function trustFilePath(installRoot: string): string {
  return join(installRoot, EXTENSION_TRUST_FILE_NAME)
}

/**
 * Reads the trusted-identity set. Never throws for filesystem or
 * content problems: everything unexpected reads back as empty (all
 * untrusted — fail closed for code execution).
 */
export function readExtensionTrustStates(installRoot: string): Set<string> {
  const empty = new Set<string>()
  if (typeof installRoot !== 'string' || installRoot === '') {
    return empty
  }
  let raw: string
  try {
    const path = trustFilePath(installRoot)
    if (statSync(path).size > EXTENSION_TRUST_MAX_BYTES) {
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
  if (record['version'] !== EXTENSION_TRUST_VERSION) {
    return empty
  }
  const extensions = record['extensions']
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) {
    return empty
  }
  const result = new Set<string>()
  for (const [key, value] of Object.entries(extensions as Record<string, unknown>)) {
    if (result.size >= EXTENSION_TRUST_MAX_ENTRIES) {
      break
    }
    if (!isValidTrustKey(key)) {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const fields = Object.keys(value as Record<string, unknown>)
    if (fields.length !== 1 || fields[0] !== 'trusted') {
      continue
    }
    if ((value as Record<string, unknown>)['trusted'] !== true) {
      continue
    }
    result.add(key)
  }
  return result
}

/** Whether one exact installed version is trusted (version-pinned). */
export function isExtensionTrusted(installRoot: string, identity: ValidatedInstallIdentity): boolean {
  return readExtensionTrustStates(installRoot).has(extensionTrustKey(identity))
}

/**
 * Persists one trust flag through temp file + atomic rename.
 * `trusted: false` removes the key (untrusted is the absence of trust).
 * Only strict keys ever land on disk. Throws on filesystem failure.
 */
export function writeExtensionTrust(
  installRoot: string,
  identity: ValidatedInstallIdentity,
  trusted: boolean
): void {
  if (typeof installRoot !== 'string' || installRoot === '') {
    throw new Error('Install root is not valid.')
  }
  const current = readExtensionTrustStates(installRoot)
  const key = extensionTrustKey(identity)
  if (trusted) {
    current.add(key)
  } else {
    current.delete(key)
  }
  const extensions: Record<string, { trusted: true }> = {}
  let count = 0
  for (const entry of current) {
    if (count >= EXTENSION_TRUST_MAX_ENTRIES) {
      break
    }
    if (!isValidTrustKey(entry)) {
      continue
    }
    extensions[entry] = { trusted: true }
    count += 1
  }
  const payload = JSON.stringify({ version: EXTENSION_TRUST_VERSION, extensions }, null, 2)
  mkdirSync(installRoot, { recursive: true })
  const tmpPath = join(installRoot, `.extensions-trust-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmpPath, trustFilePath(installRoot))
}
