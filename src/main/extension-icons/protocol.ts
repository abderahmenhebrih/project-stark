/**
 * stark-extension-icon:// resource protocol (extension icons only).
 *
 * The renderer may request extension-icon bytes ONLY by opaque icon
 * ID: `stark-extension-icon://<32 lowercase hex>`. Main resolves the
 * ID through the icon service cache — URL pathnames never map to the
 * filesystem and never select a remote URL, so traversal and
 * server-side-request-forgery are structurally impossible. Unknown IDs
 * and malformed URLs answer 404 with no detail. This module imports
 * no Electron APIs so request parsing stays unit-testable in plain
 * Node; registration (`registerSchemesAsPrivileged` before app ready,
 * `protocol.handle` once services exist) lives in main/index.ts.
 */

/** Custom scheme name served to renderer <img> elements. */
export const EXTENSION_ICON_PROTOCOL = 'stark-extension-icon'

/** Opaque main-generated icon IDs: 32 lowercase hex characters. */
export const EXTENSION_ICON_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * Parses one protocol URL into its icon ID, or null when the URL is
 * anything but exactly `stark-extension-icon://<id>` (no path,
 * query, credentials, port, or extra segments).
 */
export function parseExtensionIconUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== `${EXTENSION_ICON_PROTOCOL}:`) {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return null
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const id = parsed.hostname.toLowerCase()
  if (!EXTENSION_ICON_ID_PATTERN.test(id)) {
    return null
  }
  return id
}

/** Minimal icon content shape the protocol handler serves. */
export interface ExtensionIconContent {
  readonly bytes: Buffer
  readonly contentType: string
}

/**
 * Builds the protocol Response for one request URL. The resolver is
 * the icon service cache read (ID → bytes); unknown IDs and every
 * failure collapse to a detail-free 404 — never a 500 with
 * internals, never a directory listing.
 */
export function serveExtensionIconRequest(
  url: string,
  resolve: (id: string) => ExtensionIconContent
): Response {
  const id = parseExtensionIconUrl(url)
  if (id === null) {
    return new Response('Not found.', { status: 404 })
  }
  let content: ExtensionIconContent
  try {
    content = resolve(id)
  } catch {
    return new Response('Not found.', { status: 404 })
  }
  return new Response(new Uint8Array(content.bytes), {
    status: 200,
    headers: {
      'Content-Type': content.contentType,
      'Content-Length': String(content.bytes.length)
    }
  })
}
