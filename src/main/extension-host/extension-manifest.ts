import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validatedInstallIdentity, type ValidatedInstallIdentity } from '../extension-install/extension-install-service'
import { ExtensionActivationError } from './extension-activation-errors'

/**
 * Generic ExtensionManifest model (Step 7 activation core).
 *
 * Reads `extension/package.json` as DATA ONLY (JSON.parse + field
 * comparison — never require/import/eval) and normalizes only the
 * bounded fields STARK needs. Arbitrary raw package.json is never
 * sent to the renderer or the host: callers receive this subset.
 *
 * Bounds keep every field display- and wire-safe:
 * - manifest bytes capped at 1 MiB
 * - identity parts reuse installer charset/length rules
 * - main/browser paths capped at 512 code units
 * - activationEvents capped at 128 entries of 256 chars
 * - engines/category/extensionKind bounded small arrays
 * - contributes kept only as a bounded known-shape subset
 */

export const EXTENSION_MANIFEST_MAX_BYTES = 1024 * 1024
export const EXTENSION_MANIFEST_MAX_PATH_LENGTH = 512
export const EXTENSION_MANIFEST_MAX_ACTIVATION_EVENTS = 128
export const EXTENSION_MANIFEST_MAX_ACTIVATION_EVENT_LENGTH = 256
export const EXTENSION_MANIFEST_MAX_DISPLAY_NAME_LENGTH = 256
export const EXTENSION_MANIFEST_MAX_ENGINE_LENGTH = 64
export const EXTENSION_MANIFEST_MAX_CATEGORIES = 32
export const EXTENSION_MANIFEST_MAX_CATEGORY_LENGTH = 64
export const EXTENSION_MANIFEST_MAX_KINDS = 8
export const EXTENSION_MANIFEST_MAX_CONTRIBUTES_KEYS = 32
export const EXTENSION_MANIFEST_MAX_CONTRIBUTES_BYTES = 16 * 1024

export interface NormalizedExtensionManifest {
  readonly name: string
  readonly publisher: string
  readonly version: string
  readonly displayName: string
  readonly main: string | null
  readonly browser: string | null
  readonly activationEvents: readonly string[]
  readonly enginesVscode: string | null
  readonly extensionKind: readonly string[]
  readonly categories: readonly string[]
  /** Bounded contributes subset (data only, never executed). */
  readonly contributes: Record<string, unknown> | null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value === '' || value.length > maxLength) {
    return null
  }
  if (value.includes('\0')) {
    return null
  }
  return value
}

function normalizeActivationEvents(value: unknown): readonly string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (value.length > EXTENSION_MANIFEST_MAX_ACTIVATION_EVENTS) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || entry.length > EXTENSION_MANIFEST_MAX_ACTIVATION_EVENT_LENGTH || entry.includes('\0')) {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
    out.push(entry)
  }
  return out
}

function normalizeStringArray(value: unknown, maxEntries: number, maxLength: number): readonly string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (value.length > maxEntries) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || entry.length > maxLength || entry.includes('\0')) {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
    out.push(entry)
  }
  return out
}

function normalizeContributes(value: unknown): Record<string, unknown> | null {
  if (value === undefined) {
    return null
  }
  if (!isPlainRecord(value)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const keys = Object.keys(value)
  if (keys.length > EXTENSION_MANIFEST_MAX_CONTRIBUTES_KEYS) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (key === '' || key.length > EXTENSION_MANIFEST_MAX_CATEGORY_LENGTH || key.includes('\0')) {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
    out[key] = value[key]
  }
  let serialized: string
  try {
    serialized = JSON.stringify(out) ?? ''
  } catch {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (Buffer.byteLength(serialized, 'utf8') > EXTENSION_MANIFEST_MAX_CONTRIBUTES_BYTES) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  return out
}

/**
 * Reads and normalizes `extension/package.json` under a verified
 * version directory as DATA ONLY. Proves name/publisher/version
 * match the requested identity. Throws ExtensionActivationError
 * with `invalid-manifest` or `manifest-mismatch` — never raw I/O
 * detail.
 */
export function readNormalizedManifest(versionDir: string, identity: ValidatedInstallIdentity): NormalizedExtensionManifest {
  const manifestPath = join(versionDir, 'extension', 'package.json')
  let size: number
  try {
    size = statSync(manifestPath).size
  } catch {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (size <= 0 || size > EXTENSION_MANIFEST_MAX_BYTES) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  return normalizeManifestData(parsed, identity)
}

/**
 * Normalizes already-parsed package.json data (pure, testable).
 * Identity must match exactly; only bounded fields survive.
 */
export function normalizeManifestData(raw: unknown, identity: ValidatedInstallIdentity): NormalizedExtensionManifest {
  if (!isPlainRecord(raw)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  // Strict identity match against the requested install identity.
  if (raw['name'] !== identity.name || raw['publisher'] !== identity.namespace || raw['version'] !== identity.version) {
    throw new ExtensionActivationError('manifest-mismatch', 'Extension manifest does not match the installed extension.')
  }
  // Re-validate identity charset through the installer gate so a
  // crafted manifest can never widen accepted coordinates.
  try {
    validatedInstallIdentity({ namespace: identity.namespace, name: identity.name, version: identity.version })
  } catch {
    throw new ExtensionActivationError('manifest-mismatch', 'Extension manifest does not match the installed extension.')
  }
  const displayRaw = boundedString(raw['displayName'], EXTENSION_MANIFEST_MAX_DISPLAY_NAME_LENGTH)
  const displayName = displayRaw !== null ? displayRaw.trim() !== '' ? displayRaw.trim() : identity.name : identity.name
  const mainRaw = raw['main']
  const browserRaw = raw['browser']
  const main = mainRaw === undefined ? null : boundedString(mainRaw, EXTENSION_MANIFEST_MAX_PATH_LENGTH)
  const browser = browserRaw === undefined ? null : boundedString(browserRaw, EXTENSION_MANIFEST_MAX_PATH_LENGTH)
  if ((mainRaw !== undefined && main === null) || (browserRaw !== undefined && browser === null)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const activationEvents = normalizeActivationEvents(raw['activationEvents'])
  let enginesVscode: string | null = null
  if (raw['engines'] !== undefined) {
    if (!isPlainRecord(raw['engines'])) {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
    const enginesVscodeRaw = raw['engines']['vscode']
    if (enginesVscodeRaw !== undefined) {
      enginesVscode = boundedString(enginesVscodeRaw, EXTENSION_MANIFEST_MAX_ENGINE_LENGTH)
      if (enginesVscode === null) {
        throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
      }
    }
  }
  const extensionKind = normalizeStringArray(raw['extensionKind'], EXTENSION_MANIFEST_MAX_KINDS, EXTENSION_MANIFEST_MAX_CATEGORY_LENGTH)
  const categories = normalizeStringArray(raw['categories'], EXTENSION_MANIFEST_MAX_CATEGORIES, EXTENSION_MANIFEST_MAX_CATEGORY_LENGTH)
  const contributes = normalizeContributes(raw['contributes'])
  // `scripts.*` / install hooks are never normalized and never
  // executed: activation loads only the resolved `main` entrypoint.
  return {
    name: identity.name,
    publisher: identity.namespace,
    version: identity.version,
    displayName,
    main,
    browser,
    activationEvents,
    enginesVscode,
    extensionKind,
    categories,
    contributes
  }
}

/**
 * Extension-kind gate for Step 7: only Node/workspace-style
 * extensions whose manifest provides `main` may activate. A
 * browser-only manifest (`browser` without `main`) reports
 * `unsupported-extension-kind` — STARK never fakes compatibility.
 */
export function requireSupportedExtensionKind(manifest: NormalizedExtensionManifest): void {
  if (manifest.main !== null && manifest.main !== '') {
    return
  }
  throw new ExtensionActivationError('unsupported-extension-kind', 'This extension is not supported in STARK yet.')
}

/** Declarative contribution keys needing no code execution. */
const DECLARATIVE_CONTRIBUTION_KEYS: readonly string[] = [
  'languages',
  'grammars',
  'snippets',
  'themes',
  'iconThemes',
  'configuration',
  'commands',
  'keybindings',
  'menus',
  'colors'
]

/** Contribution keys that require extension code to mean anything. */
const EXECUTABLE_CONTRIBUTION_KEYS: readonly string[] = [
  'webviews',
  'customEditors',
  'views',
  'debuggers',
  'breakpoints',
  'terminal',
  'notebooks',
  'taskDefinitions',
  'problemMatchers',
  'authentication',
  'comments',
  'timeline',
  'fileSystemProviders'
]

/**
 * Whether a manifest is purely declarative (Step 9): no `main`, no
 * `browser`, at least one declarative contribution key, and no
 * executable-only keys. Such extensions need no activation — their
 * contributions apply without running code.
 */
export function isDeclarativeOnlyManifest(manifest: NormalizedExtensionManifest): boolean {
  if (manifest.main !== null || manifest.browser !== null) {
    return false
  }
  if (manifest.contributes === null) {
    return false
  }
  const keys = Object.keys(manifest.contributes)
  if (keys.length === 0) {
    return false
  }
  if (keys.some((key) => (EXECUTABLE_CONTRIBUTION_KEYS as readonly string[]).includes(key))) {
    return false
  }
  return keys.some((key) => (DECLARATIVE_CONTRIBUTION_KEYS as readonly string[]).includes(key))
}
