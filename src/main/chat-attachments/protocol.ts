/**
 * stark-attachment:// content protocol (display only).
 *
 * The renderer may request attachment bytes ONLY by opaque attachment
 * ID: `stark-attachment://<32 lowercase hex>`. Main resolves the ID
 * through the attachment store — URL pathnames never map to the
 * filesystem, so traversal is structurally impossible. Unknown IDs
 * and malformed URLs answer 404 with no detail. This module imports
 * no Electron APIs so request parsing stays unit-testable in plain
 * Node; registration (`registerSchemesAsPrivileged` before app ready,
 * `protocol.handle` once services exist) lives in main/index.ts.
 */

/** Custom scheme name served to renderer <img> elements. */
export const ATTACHMENT_PROTOCOL = 'stark-attachment'

/** Opaque main-generated attachment IDs: 32 lowercase hex characters. */
export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * Parses one protocol URL into its attachment ID, or null when the
 * URL is anything but exactly `stark-attachment://<id>` (no path,
 * query, credentials, port, or extra segments).
 */
export function parseAttachmentUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ATTACHMENT_PROTOCOL}:`) {
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
  if (!ATTACHMENT_ID_PATTERN.test(id)) {
    return null
  }
  return id
}

/** Minimal content shape the protocol handler serves. */
export interface AttachmentContent {
  readonly bytes: Buffer
  readonly mimeType: string
}

/**
 * Builds the protocol Response for one request URL. The resolver is
 * the attachment store read (ID → bytes); unknown IDs and every
 * failure collapse to a detail-free 404 — never a 500 with
 * internals, never a directory listing.
 */
export function serveAttachmentRequest(
  url: string,
  resolve: (id: string) => AttachmentContent
): Response {
  const id = parseAttachmentUrl(url)
  if (id === null) {
    return new Response('Not found.', { status: 404 })
  }
  let content: AttachmentContent
  try {
    content = resolve(id)
  } catch {
    return new Response('Not found.', { status: 404 })
  }
  return new Response(new Uint8Array(content.bytes), {
    status: 200,
    headers: {
      'Content-Type': content.mimeType,
      'Content-Length': String(content.bytes.length)
    }
  })
}
