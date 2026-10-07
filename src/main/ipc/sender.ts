import { fileURLToPath } from 'node:url'

/**
 * IPC sender validation.
 *
 * Pure module: no Electron imports, so the trust checks stay testable
 * outside the Electron runtime. Enforcement lives in ./index.ts via
 * handleSecureIpc, which every privileged handler must use.
 */

export interface RendererTrustPolicy {
  /** Vite dev-server URL when running unpackaged; undefined in production. */
  readonly devServerUrl: string | undefined
  /**
   * Absolute filesystem path of STARK's own renderer entry document —
   * the exact file loadFile() opens (see RENDERER_ENTRY in
   * ../security/app-urls.ts). Required for production trust; when it is
   * unknown, production senders fail closed.
   */
  readonly rendererEntryFile: string | undefined
}

/**
 * Normalizes a filesystem path for comparison: unified separators and,
 * on case-insensitive filesystems (Windows, default macOS), folded case.
 * Both sides of the trust comparison pass through here so platform
 * spelling differences (slashes, drive-letter case) cannot cause a
 * mismatch — or a false accept.
 */
function normalizePathForCompare(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const withoutLeadingSlash = slashed.replace(/^\/([A-Za-z]:\/)/, '$1')
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return withoutLeadingSlash.toLowerCase()
  }
  return withoutLeadingSlash
}

/**
 * True only when the sender URL resolves to STARK's exact renderer entry
 * document. Conversion uses fileURLToPath (correct decoding, drive
 * letters, UNC/host rejection); comparison is against the known entry
 * file — never a filename or path suffix.
 */
function isExpectedEntryDocument(senderUrl: string, rendererEntryFile: string): boolean {
  let senderPath: string
  try {
    senderPath = fileURLToPath(senderUrl)
  } catch {
    return false
  }
  return normalizePathForCompare(senderPath) === normalizePathForCompare(rendererEntryFile)
}

/**
 * Returns true only when the sender URL belongs to STARK's own renderer:
 * - development: same origin as the Vite dev server.
 * - production: the exact packaged renderer entry document.
 *
 * This is origin/document validation, not a user-controlled token check:
 * the URL is reported by Electron for the calling WebContents itself.
 */
export function isTrustedRendererUrl(senderUrl: string | undefined, policy: RendererTrustPolicy): boolean {
  if (senderUrl === undefined || senderUrl === '') {
    return false
  }
  if (policy.devServerUrl !== undefined && policy.devServerUrl !== '') {
    let parsed: URL
    let devOrigin: string
    try {
      parsed = new URL(senderUrl)
      devOrigin = new URL(policy.devServerUrl).origin
    } catch {
      return false
    }
    return parsed.origin === devOrigin
  }
  if (policy.rendererEntryFile === undefined || policy.rendererEntryFile === '') {
    return false
  }
  return isExpectedEntryDocument(senderUrl, policy.rendererEntryFile)
}
