import { createHash } from 'node:crypto'
import { EXTENSION_ICON_PROTOCOL, type ExtensionIconContent } from './protocol'
import { sniffImageMime } from '../chat-attachments/mime'

/**
 * Main-owned extension-icon delivery (icons only, never a generic
 * remote-image proxy).
 *
 * Runtime root cause (corrective pass): two independent defects made
 * valid Open VSX artwork fall back inconsistently.
 *
 * 1. Over-strict filename pinning. The validator accepted only
 *    `[A-Za-z0-9._-]` file names, but the live catalog serves
 *    legitimate retina assets such as `logo@128.png` and
 *    `informix_icon_big@2x.png` (observed via bounded catalog
 *    inspection), plus single-file ICO assets (`extension_icon.ico`,
 *    served as image/x-icon or octet-stream). Those entries resolved
 *    to null before any network attempt and always rendered the
 *    generic fallback.
 *
 * 2. Renderer-side stale failure state. Catalog rows keyed by
 *    `namespace.name` (no version) reused one component instance
 *    across icon-URL changes, so a once-failed entry never retried a
 *    new opaque URL. The renderer now resets its failure flag
 *    whenever the icon URL changes (see ExtensionsPanel).
 *
 * Delivery design: the catalog service resolves each validated icon
 * here, main-side, into opaque `stark-extension-icon://<id>` bytes
 * served by the protocol handler in ./protocol.ts. The renderer never
 * sees a remote icon URL. IDs are deterministic main-owned mappings
 * (SHA-256 of the validated source, truncated to 32 hex chars): a
 * catalog reload for the same source re-resolves to the SAME opaque
 * URL, so remounts and reloads can never strand a valid icon behind
 * a stale random ID. Reads refresh LRU order so frequently displayed
 * icons are evicted last.
 *
 * Bounds per icon: single attempt (zero retries), 10s timeout, at
 * most 2 MiB, at most 3 validated redirect hops, accepted response
 * types image/png, image/jpeg, image/webp, image/gif, image/x-icon
 * (ICO), and image/svg+xml through the strict validator below. The
 * Eclipse content host serves many valid raster icons as
 * `application/octet-stream` (observed live: real PNG bytes, generic
 * type, e.g. meta.pyrefly, redhat.java, golang.Go, eamodio.gitlens);
 * those responses are accepted ONLY when the downloaded bytes sniff
 * as a supported raster signature, and are then served under the
 * sniffed type — the declared type is never trusted on its own.
 * `binary/octet-stream` is treated identically. Every redirect hop
 * is re-validated against the two explicitly confirmed official
 * origins below; anything else resolves to null and the renderer
 * falls back once for that entry. One failure means one fallback —
 * no reload loop (callers resolve once per catalog load; failures are
 * cached as null).
 */

/** Single-attempt network bound per icon request (redirect hops share it). */
export const EXTENSION_ICON_TIMEOUT_MS = 10_000

/** Maximum accepted icon bytes (declared or streamed). */
export const EXTENSION_ICON_MAX_BYTES = 2 * 1024 * 1024

/** Maximum validated redirect hops per icon (single attempt, no retries). */
export const EXTENSION_ICON_MAX_REDIRECTS = 3

/** Maximum cached icons (successes and failures); oldest evicted first. */
export const EXTENSION_ICON_MAX_CACHED = 200

/** Accepted icon response types only (SVG gated by the strict validator below). */
export const EXTENSION_ICON_ALLOWED_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml'
]

/** Maximum SVG bytes accepted (SVG is text; the 2 MiB cap still applies, this is tighter). */
export const EXTENSION_ICON_MAX_SVG_BYTES = 256 * 1024

/** Fixed registry origin for catalog icon sources. Never renderer-supplied. */
export const EXTENSION_ICON_REGISTRY_ORIGIN = 'https://open-vsx.org'

/**
 * Explicitly confirmed official Open VSX asset host. Verified from
 * live Open VSX 302 `location` responses for both icon and VSIX
 * file URLs (served under cache `openvsx.eclipsecontent.org` via the
 * Eclipse Foundation content network). No wildcard, no subdomain
 * allowance — exactly this hostname.
 */
export const EXTENSION_ICON_CDN_HOST = 'openvsx.eclipsecontent.org'

/** Maximum catalog identity part length accepted in pinned paths. */
const MAX_PATH_SEGMENT_LENGTH = 128

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * File-name segment rule (broader than coordinate segments on
 * purpose): live catalog filenames include retina `@2x` assets
 * (`logo@128.png`, `informix_icon_big@2x.png`). `+` and `~` are
 * accepted for the same reason (observed URL-safe asset names); `/`,
 * `\`, traversal, control characters, and queries remain impossible
 * (segments come from pathname splitting; search/hash rejected
 * above; `..` rejected after decoding).
 */
const SAFE_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~+@-]*$/

function cleanFileSegment(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    value.length <= MAX_PATH_SEGMENT_LENGTH &&
    !value.includes('%2e') &&
    !value.includes('%2E') &&
    !value.includes('\0') &&
    SAFE_FILE_SEGMENT.test(value)
  )
}
export interface ExtensionIconIdentity {
  readonly namespace: string
  readonly name: string
  readonly version: string
}

/** Minimal fetch shape (global fetch in production, fakes in tests). */
export type IconFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect?: 'manual' }
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: unknown
}>

/** Stored icon bytes served by opaque ID (same shape as the protocol content). */
export type StoredExtensionIcon = ExtensionIconContent

function cleanSegment(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    value.length <= MAX_PATH_SEGMENT_LENGTH &&
    !value.includes('%2e') &&
    !value.includes('%2E') &&
    SAFE_SEGMENT.test(value)
  )
}

/**
 * Strict extension-icon source validation with catalog-identity path
 * pinning (pure, testable). Accepts ONLY:
 * - `https://open-vsx.org/api/<namespace>/<name>/<version>/file/<file...>`
 * - `https://open-vsx.org/api/<namespace>/<name>/<platform>/<version>/file/<file...>`
 * - `https://openvsx.eclipsecontent.org/<namespace>/<name>/<version>/<file...>`
 * - `https://openvsx.eclipsecontent.org/<namespace>/<name>/<platform>/<version>/<file...>`
 * where namespace/name/version equal the catalog identity and
 * `<file...>` is one or more contained file-path segments (nested
 * icon asset paths stay pinned: every file segment is validated,
 * `..` and separators rejected). Everything else (foreign hosts,
 * userinfo, ports, queries, traversal, mismatched identity)
 * normalizes to null. Applies to catalog-resolved sources and every
 * redirect hop.
 */
export function validatedIconSourceUrl(value: unknown, identity: ExtensionIconIdentity): string | null {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') {
    return null
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return null
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  let segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  try {
    segments = segments.map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
  // Reject encoded separators/traversal that survive splitting
  // (`%2F` decodes to `/`, `%5C` to `\`): a decoded segment must
  // never introduce a separator or parent reference.
  if (segments.some((segment) => segment.includes('/') || segment.includes('\\'))) {
    return null
  }
  if (host === 'open-vsx.org') {
    // Registry resource form:
    // /api/<ns>/<name>[/<platform>]/<version>/file/<file...>.
    // Coordinates are 3 or 4 leading segments, then the literal
    // `file` marker, then one or more contained file segments.
    if (segments.length < 6 || segments[0] !== 'api') {
      return null
    }
    const rest = segments.slice(1)
    const markerAt = rest[3] === 'file' ? 3 : rest[4] === 'file' ? 4 : -1
    if (markerAt === -1) {
      return null
    }
    const coords = rest.slice(0, markerAt)
    const files = rest.slice(markerAt + 1)
    if (files.length < 1 || files.some((file) => file === '' || file === '.' || file === '..')) {
      return null
    }
    if (!pinsIdentity(coords, identity)) {
      return null
    }
    if (!coords.every(cleanSegment) || !files.every(cleanFileSegment)) {
      return null
    }
    return parsed.toString()
  }
  if (host === EXTENSION_ICON_CDN_HOST) {
    // Official asset-host form:
    // /<ns>/<name>[/<platform>]/<version>/<file...> (file part is
    // one or more contained segments).
    if (segments.length < 4) {
      return null
    }
    for (const coordLength of [4, 3]) {
      const coords = segments.slice(0, coordLength)
      const files = segments.slice(coordLength)
      if (files.length < 1) {
        continue
      }
      if (!pinsIdentity(coords, identity)) {
        continue
      }
      if (!coords.every(cleanSegment) || !files.every(cleanFileSegment)) {
        continue
      }
      return parsed.toString()
    }
    return null
  }
  return null
}

/**
 * Coordinate pinning: [namespace, name, version] or
 * [namespace, name, platform, version], all equal to the catalog
 * identity (platform is registry-safe but otherwise unconstrained).
 */
function pinsIdentity(coords: readonly string[], identity: ExtensionIconIdentity): boolean {
  if (coords.length !== 3 && coords.length !== 4) {
    return false
  }
  const [namespace, name] = coords
  const version = coords[coords.length - 1]
  return namespace === identity.namespace && name === identity.name && version === identity.version
}

function parseContentType(value: string | null): string | null {
  if (value === null || value === '') {
    return null
  }
  const type = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return (EXTENSION_ICON_ALLOWED_TYPES as readonly string[]).includes(type) ? type : null
}

/**
 * ICO magic sniff (icon-only; the shared attachment sniffer stays
 * raster-only on purpose). ICO files begin `00 00 01 00` (icon) or
 * `00 00 02 00` (cursor); both render in Chromium `<img>`.
 */
function sniffIcoMime(head: Buffer): 'image/x-icon' | null {
  if (
    head.length >= 4 &&
    head[0] === 0x00 &&
    head[1] === 0x00 &&
    (head[2] === 0x01 || head[2] === 0x02) &&
    head[3] === 0x00
  ) {
    return 'image/x-icon'
  }
  return null
}

/**
 * Strict STARK SVG validation (no reviewed third-party sanitizer is
 * vendored; this path validates instead of transforming).
 *
 * Accepts only bounded UTF-8 text whose first meaningful markup is an
 * `<svg` element, and rejects at minimum:
 * - `<script`, `<foreignObject`, `<iframe`, `<embed`, `<object`,
 *   `<html`, `<image` with external references
 * - event-handler attributes (`on*=`), `javascript:` / `vbscript:` /
 *   `file:` / `data:text/html` URLs
 * - external resource references: `href`/`src`/`xlink:href` bearing
 *   `http(s)://`, `url(http`, protocol-relative `//`, `@import`
 * - `<!ENTITY` declarations (XXE / billion-laughs)
 * - embedded `<?php`, `<%` executable content
 *
 * Plain `xmlns="http://www.w3.org/2000/svg"` namespace declarations
 * are explicitly ALLOWED (required by legitimate SVGs) — only
 * resource-bearing attributes are scanned for remote URLs.
 * Anything rejected here falls back to the generic glyph; the reason
 * is never rendered. Returns the sanitized-exact input bytes on
 * success (validation only, no rewrite).
 */
export function validateSvgIconBytes(bytes: Buffer): Buffer | null {
  if (bytes.length === 0 || bytes.length > EXTENSION_ICON_MAX_SVG_BYTES) {
    return null
  }
  let text: string
  try {
    text = bytes.toString('utf8')
  } catch {
    return null
  }
  // Must decode losslessly: overlong/invalid sequences indicate a
  // non-text payload masquerading as SVG.
  if (Buffer.from(text, 'utf8').length !== bytes.length) {
    return null
  }
  if (text.includes(' ')) {
    return null
  }
  const lowered = text.toLowerCase()
  // First meaningful markup must be the svg root (optional XML
  // declaration, doctype-free preamble, comments, and whitespace
  // are skipped; anything else fails closed).
  const withoutPreamble = lowered
    .replace(/^\s*(<\?xml[^?]*\?>\s*)?/, '')
    .replace(/^(\s*<!--[\s\S]*?-->\s*)*/, '')
  if (!withoutPreamble.startsWith('<svg')) {
    return null
  }
  const forbidden = [
    '<script',
    '<foreignobject',
    '<iframe',
    '<embed',
    '<object',
    '<html',
    '<!entity',
    '<?php',
    '<%',
    'javascript:',
    'vbscript:',
    'file:',
    'data:text/html',
    '@import'
  ]
  for (const marker of forbidden) {
    if (lowered.includes(marker)) {
      return null
    }
  }
  // Event-handler attributes (` onclick=`, `<svg onload=`, ...).
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(text)) {
    return null
  }
  // External resource references on payload-bearing attributes.
  // `xmlns*` namespace declarations are exempt (matched separately
  // below by stripping them first).
  const withoutNamespaces = text.replace(/\s+xmlns(?::[a-z]+)?\s*=\s*("[^"]*"|'[^']*')/gi, '')
  if (/(href|src|xlink:href)\s*=\s*("|')\s*(https?:|protocol-relative)/i.test(withoutNamespaces)) {
    return null
  }
  if (/(href|src|xlink:href)\s*=\s*("|')\s*\/?\//i.test(withoutNamespaces)) {
    return null
  }
  if (/url\(\s*("|')?\s*https?:/i.test(withoutNamespaces)) {
    return null
  }
  if (/url\(\s*("|')?\s*\/\//i.test(withoutNamespaces)) {
    return null
  }
  return bytes
}

/**
 * Resolves the served icon type from the declared Content-Type plus
 * magic-byte sniffing of the downloaded body. Magic wins when it
 * identifies a supported raster/ICO format — this accepts valid icons
 * the asset host labels `application/octet-stream` (or omits/mangles
 * the type of) and corrects mismatched declarations. SVG text never
 * matches a raster signature: it is accepted ONLY through the strict
 * validator above when the declared type is `image/svg+xml` or the
 * body arrived as generic bytes (`application/octet-stream`,
 * `binary/octet-stream`, or missing) — never on declaration alone.
 * The declared type is never trusted on its own.
 */
function resolveIconContentType(
  rawContentType: string | null,
  declared: string | null,
  bytes: Buffer
): string | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 16))
  const sniffed = sniffImageMime(head) ?? sniffIcoMime(head)
  if (sniffed !== null) {
    return sniffed
  }
  const raw = rawContentType === null ? '' : rawContentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const genericBytes = raw === '' || raw === 'application/octet-stream' || raw === 'binary/octet-stream'
  if (declared === 'image/svg+xml' || genericBytes) {
    // SVG is never served on declaration alone: invalid SVG falls
    // back even when the server claims `image/svg+xml`.
    return validateSvgIconBytes(bytes) !== null ? 'image/svg+xml' : null
  }
  // Mismatched declaration correction (mirrors the raster path):
  // SVG bytes mislabeled as a raster type still serve as validated
  // SVG instead of falling back.
  if (validateSvgIconBytes(bytes) !== null) {
    return 'image/svg+xml'
  }
  return declared
}

/**
 * Deterministic main-owned opaque ID for a validated icon source
 * (SHA-256, truncated to the 32-hex protocol shape). The same source
 * always maps to the same opaque URL across catalog reloads, renderer
 * remounts, and version-pinned queries — no random ID can strand a
 * valid icon behind a stale mapping.
 */
export function deterministicIconId(validatedSourceUrl: string): string {
  return createHash('sha256').update(validatedSourceUrl, 'utf8').digest('hex').slice(0, 32)
}

export class ExtensionIconService {
  private readonly fetchImpl: IconFetch
  private readonly cache = new Map<string, { readonly id: string; readonly stored: StoredExtensionIcon } | null>()
  private readonly byId = new Map<string, StoredExtensionIcon>()

  constructor(fetchImpl?: IconFetch) {
    this.fetchImpl =
      fetchImpl ?? ((globalThis.fetch as unknown as IconFetch | undefined) as IconFetch)
  }

  /**
   * Resolves one catalog icon to an opaque resource URL, or null when
   * the source is invalid or the icon genuinely fails. Exactly one
   * network attempt, zero retries, bounded bytes and hops. Results
   * (including failures) are cached so catalog reloads never loop.
   */
  async resolveIcon(sourceUrl: string | null, identity: ExtensionIconIdentity): Promise<string | null> {
    const outcome = await this.loadIcon(sourceUrl, identity)
    return outcome === null ? null : `${EXTENSION_ICON_PROTOCOL}://${outcome.id}`
  }

  /**
   * Narrow install-time accessor: returns validated icon bytes for
   * persistence alongside the installed package (same single-attempt,
   * same bounds, same allowlist as catalog resolution). Null when the
   * source is invalid or the icon genuinely fails — callers fall back
   * to the generic glyph and must never fail an install over icons.
   */
  async fetchIconBytes(sourceUrl: string | null, identity: ExtensionIconIdentity): Promise<StoredExtensionIcon | null> {
    const outcome = await this.loadIcon(sourceUrl, identity)
    return outcome === null ? null : outcome.stored
  }

  private async loadIcon(
    sourceUrl: string | null,
    identity: ExtensionIconIdentity
  ): Promise<{ readonly id: string; readonly stored: StoredExtensionIcon } | null> {
    if (sourceUrl === null) {
      return null
    }
    const validated = validatedIconSourceUrl(sourceUrl, identity)
    if (validated === null) {
      return null
    }
    const cached = this.cache.get(validated)
    if (cached !== undefined) {
      // LRU touch: a displayed icon stays cached while in use.
      this.cache.delete(validated)
      this.cache.set(validated, cached)
      if (cached !== null) {
        this.touchById(cached.id, cached.stored)
      }
      return cached
    }
    let outcome: { readonly id: string; readonly stored: StoredExtensionIcon } | null
    try {
      outcome = await this.fetchIcon(validated, identity)
    } catch {
      outcome = null
    }
    if (this.cache.size >= EXTENSION_ICON_MAX_CACHED) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) {
        const evicted = this.cache.get(oldest.value)
        this.cache.delete(oldest.value)
        if (evicted !== null && evicted !== undefined) {
          this.byId.delete(evicted.id)
        }
      }
    }
    this.cache.set(validated, outcome)
    if (outcome !== null) {
      this.touchById(outcome.id, outcome.stored)
    }
    return outcome
  }

  private touchById(id: string, stored: StoredExtensionIcon): void {
    this.byId.delete(id)
    if (this.byId.size >= EXTENSION_ICON_MAX_CACHED) {
      const oldest = this.byId.keys().next()
      if (!oldest.done) {
        this.byId.delete(oldest.value)
      }
    }
    this.byId.set(id, stored)
  }

  /** Cache read for the protocol handler (ID → bytes, throws when unknown). */
  readIconContent(id: string): StoredExtensionIcon {
    const direct = this.byId.get(id)
    if (direct !== undefined) {
      // LRU touch so served icons survive while displayed.
      this.byId.delete(id)
      this.byId.set(id, direct)
      return direct
    }
    for (const entry of this.cache.values()) {
      if (entry !== null && entry.id === id) {
        this.touchById(id, entry.stored)
        return entry.stored
      }
    }
    throw new Error('Unknown extension icon.')
  }

  private async fetchIcon(url: string, identity: ExtensionIconIdentity): Promise<{ readonly id: string; readonly stored: StoredExtensionIcon }> {
    let current = url
    for (let hop = 0; hop <= EXTENSION_ICON_MAX_REDIRECTS; hop += 1) {
      const allowed = validatedIconSourceUrl(current, identity)
      if (allowed === null) {
        throw new Error('Icon redirect escaped the allowlist.')
      }
      let response: {
        readonly ok: boolean
        readonly status: number
        readonly headers: { get(name: string): string | null }
        readonly body: unknown
      }
      try {
        response = await this.fetchImpl(allowed, {
          headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/svg+xml' },
          signal: AbortSignal.timeout(EXTENSION_ICON_TIMEOUT_MS),
          redirect: 'manual'
        })
      } catch {
        throw new Error('Icon request failed.')
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') {
          throw new Error('Icon redirect escaped the allowlist.')
        }
        try {
          current = new URL(location, allowed).toString()
        } catch {
          throw new Error('Icon redirect escaped the allowlist.')
        }
        continue
      }
      if (!response.ok) {
        throw new Error('Icon request failed.')
      }
      const declared = parseContentType(response.headers.get('content-type'))
      const length = parseByteLength(response.headers.get('content-length'))
      if (length !== null && length > EXTENSION_ICON_MAX_BYTES) {
        throw new Error('Icon exceeds the size limit.')
      }
      const bytes = await readBoundedBytes(response.body)
      const contentType = resolveIconContentType(response.headers.get('content-type'), declared, bytes)
      if (contentType === null) {
        throw new Error('Icon response is not a supported image.')
      }
      return {
        id: deterministicIconId(url),
        stored: { bytes, contentType }
      }
    }
    throw new Error('Icon redirect escaped the allowlist.')
  }
}

function parseByteLength(value: string | null): number | null {
  if (value === null || value === '') {
    return null
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null
  }
  return parsed
}

async function readBoundedBytes(body: unknown): Promise<Buffer> {
  if (body === null || typeof body !== 'object') {
    throw new Error('Icon response has no body.')
  }
  const stream = body as AsyncIterable<unknown>
  if (typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('Icon response has no body.')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > EXTENSION_ICON_MAX_BYTES) {
      throw new Error('Icon exceeds the size limit.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

