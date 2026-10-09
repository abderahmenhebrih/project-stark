/**
 * Sanitized Extension Host environment (foundation only).
 *
 * The host inherits NOTHING by default: main builds a fresh object
 * containing only allowlisted operational keys present in the current
 * environment. Anything resembling a secret is structurally excluded —
 * the allowlist simply has no room for it. The bootstrap needs no
 * credentials, tokens, provider keys, or OAuth material, so none can
 * arrive no matter what the parent process holds.
 */

/**
 * Exact variable names the host may receive. Minimal operational set:
 * executable search path, platform locale/timezone hints, temp dirs,
 * and home pointers the Node runtime itself may consult. Nothing that
 * can carry secrets.
 */
export const EXTENSION_HOST_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH'
]

/** Variable-name fragments that must never reach the host. */
const SECRET_NAME_PATTERN = /key|token|secret|password|credential|auth|bearer|session|private|signature/i

/**
 * Builds the host environment from the parent environment: exact
 * allowlist matches only, with a defense-in-depth secret-name sweep.
 * Returns a fresh object — the parent env object is never shared.
 */
export function buildExtensionHostEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set<string>(EXTENSION_HOST_ENV_ALLOWLIST)
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) {
      continue
    }
    if (!allowed.has(name)) {
      continue
    }
    if (SECRET_NAME_PATTERN.test(name)) {
      continue
    }
    out[name] = value
  }
  return out
}
