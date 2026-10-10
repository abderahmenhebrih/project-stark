import { lstatSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { EXTENSION_MANIFEST_MAX_PATH_LENGTH } from './extension-manifest'
import { ExtensionActivationError } from './extension-activation-errors'

/**
 * Generic entrypoint resolution (Step 7 activation core).
 *
 * Desktop Node extensions only: resolves `manifest.main` to an
 * absolute regular file strictly contained under the installed
 * extension content directory (`<versionDir>/extension`).
 *
 * Guarantees (fail closed, never execute):
 * - relative extension-owned path only (no absolute, drive-letter,
 *   UNC, backslash, NUL, or overlong values)
 * - canonical containment under the extension directory (no
 *   traversal, no escape via `..` or symlinked prefixes — the
 *   target itself must not be a symlink)
 * - regular file only (directories, symlinks, and special entries
 *   rejected via lstat)
 * - JavaScript module only (`.js`/`.mjs`/`.cjs`)
 * - package scripts (`scripts.*`, postinstall/preinstall/prepare)
 *   are never read here and never executed anywhere: activation
 *   imports only the resolved entrypoint file URL.
 */

const DRIVE_LETTER = /^[A-Za-z]:/
const JS_MODULE = /\.(mjs|cjs|js)$/i

/**
 * Proves a candidate extension directory stays strictly beneath the
 * main-owned store root. Identity parts carry no separators
 * (validated upstream), so exact join + relative comparison proves
 * containment without ever trusting renderer input.
 */
export function verifyExtensionDirContained(storeRoot: string, extensionDir: string): string {
  if (typeof storeRoot !== 'string' || storeRoot === '' || typeof extensionDir !== 'string' || extensionDir === '') {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const root = resolve(storeRoot)
  const candidate = resolve(extensionDir)
  const rootLower = root.toLowerCase()
  const candidateLower = candidate.toLowerCase()
  if (candidateLower !== rootLower && !candidateLower.startsWith(rootLower + sep)) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  // The extension directory must be strictly beneath the root (never
  // the root itself): activation always targets an exact installed
  // version directory.
  if (candidateLower === rootLower) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  return candidate
}

/**
 * Validates a raw `main` value is a relative extension-owned path.
 * Returns the raw value when safe; throws otherwise. Extensionless
 * values (Node-style `./client/out/extension`, resolved to
 * `extension.js` below) are allowed here; containment + file probes
 * happen in resolution.
 */
export function validateEntrypointPath(rawMain: unknown): string {
  if (typeof rawMain !== 'string' || rawMain === '' || rawMain.length > EXTENSION_MANIFEST_MAX_PATH_LENGTH) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (rawMain.includes('\0') || rawMain.includes('\\')) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  if (rawMain.startsWith('/') || DRIVE_LETTER.test(rawMain) || rawMain.startsWith('//')) {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const withoutTrailing = rawMain.endsWith('/') ? rawMain.slice(0, -1) : rawMain
  if (withoutTrailing === '') {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  for (const segment of withoutTrailing.split('/')) {
    // `.` (current-dir) segments are standard (`./out/entry.js`) and
    // resolve safely; only parent escapes and empties fail closed.
    if (segment === '' || segment === '..') {
      throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
    }
  }
  return rawMain
}

function isContained(base: string, resolved: string): boolean {
  const baseLower = base.toLowerCase()
  const resolvedLower = resolved.toLowerCase()
  if (resolvedLower !== baseLower && !resolvedLower.startsWith(baseLower + sep)) {
    return false
  }
  if (resolvedLower === baseLower) {
    return false
  }
  const rel = relative(base, resolved)
  if (rel === '' || rel.startsWith('..') || resolve(base, rel) !== resolved) {
    return false
  }
  return true
}

function probeJsFile(candidate: string): string | null {
  if (!JS_MODULE.test(candidate)) {
    return null
  }
  let stats
  try {
    stats = lstatSync(candidate)
  } catch {
    return null
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return null
  }
  return candidate
}

/**
 * Resolves a validated `main` entrypoint under an extension content
 * directory to a canonical absolute JS file. Verifies containment,
 * regular-file shape (lstat, symlinks rejected), and module
 * extension. Node-style extensionless mains probe
 * `<main>.js`/`.cjs`/`.mjs` in order (bounded, max 4 candidates).
 * Never executes anything.
 */
export function resolveExtensionEntrypoint(extensionBaseDir: string, rawMain: unknown): string {
  const validated = validateEntrypointPath(rawMain)
  if (typeof extensionBaseDir !== 'string' || extensionBaseDir === '') {
    throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
  }
  const base = resolve(extensionBaseDir)
  const candidates = [validated, `${validated}.js`, `${validated}.cjs`, `${validated}.mjs`]
  for (const candidate of candidates.slice(0, 4)) {
    const resolved = resolve(base, candidate)
    if (!isContained(base, resolved)) {
      continue
    }
    const probed = probeJsFile(resolved)
    if (probed !== null) {
      return probed
    }
  }
  throw new ExtensionActivationError('invalid-manifest', 'Extension manifest is not valid.')
}
