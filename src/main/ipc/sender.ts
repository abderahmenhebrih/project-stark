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
}

/**
 * Returns true only when the sender URL belongs to STARK's own renderer:
 * - development: same origin as the Vite dev server.
 * - production: the packaged file:// renderer document.
 *
 * This is origin/document validation, not a user-controlled token check:
 * the URL is reported by Electron for the calling WebContents itself.
 */
export function isTrustedRendererUrl(senderUrl: string | undefined, policy: RendererTrustPolicy): boolean {
  if (senderUrl === undefined || senderUrl === '') {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(senderUrl)
  } catch {
    return false
  }
  if (policy.devServerUrl !== undefined && policy.devServerUrl !== '') {
    let devOrigin: string
    try {
      devOrigin = new URL(policy.devServerUrl).origin
    } catch {
      return false
    }
    return parsed.origin === devOrigin
  }
  if (parsed.protocol !== 'file:') {
    return false
  }
  if (parsed.host !== '' && parsed.host !== 'localhost') {
    return false
  }
  return parsed.pathname.endsWith('/renderer/index.html')
}
