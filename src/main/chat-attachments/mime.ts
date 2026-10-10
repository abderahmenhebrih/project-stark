/**
 * Conservative attachment MIME handling (display only, never execution).
 *
 * Image kinds come from magic-byte sniffing, never the extension:
 * only PNG, JPEG, GIF, and WebP signatures qualify. Everything else
 * resolves through a small extension map for familiar display labels,
 * falling back to application/octet-stream when uncertain. MIME never
 * drives execution — attachments stay inert regardless of type.
 */

export type SniffedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

function startsWith(head: Buffer, signature: readonly number[]): boolean {
  if (head.length < signature.length) {
    return false
  }
  return signature.every((byte, index) => head[index] === byte)
}

/**
 * Sniffs raster image signatures from the leading bytes. Returns the
 * MIME type or null when the bytes match no known image signature.
 */
export function sniffImageMime(head: Buffer): SniffedImageMime | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(head, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif'
  }
  if (
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    head.length >= 12 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonc: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'text/xml'
}

/**
 * Resolves a display MIME type: sniffed raster images win; otherwise
 * a conservative extension lookup; otherwise octet-stream. SVG and
 * HTML resolve by extension but are always stored as generic files,
 * never inline-previewed.
 */
export function resolveMimeType(head: Buffer, filename: string): string {
  const sniffed = sniffImageMime(head)
  if (sniffed !== null) {
    return sniffed
  }
  const dot = filename.lastIndexOf('.')
  if (dot !== -1 && dot < filename.length - 1) {
    const mapped = EXTENSION_MIME[filename.slice(dot + 1).toLowerCase()]
    if (mapped !== undefined) {
      return mapped
    }
  }
  return 'application/octet-stream'
}
