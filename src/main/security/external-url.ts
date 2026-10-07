/**
 * URL allowlists for navigation decisions.
 *
 * Pure module: no Electron imports, so the checks stay testable outside
 * the Electron runtime. Enforcement lives in main/windows/app-window.ts.
 */

/** External protocols STARK may hand to the OS browser. Nothing else. */
const ALLOWED_EXTERNAL_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * Returns true only for http(s) URLs with a host.
 * Rejects file:, javascript:, data:, and custom executable protocols.
 */
export function isAllowedExternalUrl(href: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return false
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    return false
  }
  return parsed.hostname !== ''
}

export interface MainFrameNavigationPolicy {
  /** Origin of the Vite dev server in development, null in production. */
  readonly devServerOrigin: string | null
  /** Absolute directory containing the packaged renderer (production). */
  readonly rendererDirectory: string
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

function fileUrlToPath(href: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') {
    return null
  }
  if (parsed.host !== '' && parsed.host !== 'localhost') {
    return null
  }
  let path = parsed.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (/^\/[A-Za-z]:\//.test(path)) {
    path = path.slice(1)
  }
  return path
}

/**
 * Returns true only when the main frame stays inside the application:
 * - development: same origin as the Vite dev server.
 * - production: a file inside the packaged renderer directory.
 * Anything else (remote pages, other local files) is denied.
 */
export function isAllowedMainFrameNavigation(href: string, policy: MainFrameNavigationPolicy): boolean {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return false
  }
  if (policy.devServerOrigin !== null) {
    return parsed.origin === policy.devServerOrigin
  }
  if (parsed.protocol !== 'file:') {
    return false
  }
  const target = fileUrlToPath(href)
  if (target === null) {
    return false
  }
  const directory = normalizePath(policy.rendererDirectory).replace(/\/?$/, '/')
  return normalizePath(target).startsWith(directory)
}
