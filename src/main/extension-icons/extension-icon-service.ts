import { randomBytes } from 'node:crypto'
import { EXTENSION_ICON_PROTOCOL, type ExtensionIconContent } from './protocol'

/**
 * Main-owned extension-icon delivery (icons only, never a generic
 * remote-image proxy).
 *
 * Runtime root cause (stabilization pass): Open VSX catalog icon URLs
 * (`https://open-vsx.org/api/...`) answer HTTP 302 to the official
 * Eclipse content host (`https://openvsx.eclipsecontent.org/...`).
 * Renderer <img> loads therefore fail the page CSP — which names only
 * open-vsx.org — and every entry fires onError into the generic
 * fallback. Instead of chasing remote hosts through renderer CSP, the
 * catalog service resolves each validated icon here, main-side, into
 * opaque `stark-extension-icon://<id>` bytes served by the protocol
 * handler in ./protocol.ts. The renderer never sees a remote icon URL.
 *
 * Bounds per icon: single attempt (zero retries), 10s timeout, at
 * most 2 MiB, at most 3 validated redirect hops, accepted response
 * types image/png, image/jpeg, image/webp, image/gif only (SVG is
 * rejected — no reviewed safe SVG policy exists). Every redirect hop
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

/** Accepted icon response types only. SVG is rejected for now. */
export const EXTENSION_ICON_ALLOWED_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

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
 * - `https://open-vsx.org/api/<namespace>/<name>/<version>/file/<file>`
 * - `https://open-vsx.org/api/<namespace>/<name>/<platform>/<version>/file/<file>`
 * - `https://openvsx.eclipsecontent.org/<namespace>/<name>/<version>/<file>`
 * - `https://openvsx.eclipsecontent.org/<namespace>/<name>/<platform>/<version>/<file>`
 * where namespace/name/version equal the catalog identity. Everything
 * else (foreign hosts, userinfo, ports, queries, traversal, mismatched
 * identity) normalizes to null. Applies to catalog-resolved sources
 * and every redirect hop.
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
  if (host === 'open-vsx.org') {
    // Registry resource form: /api/<ns>/<name>[/<platform>]/<version>/file/<file>
    if (segments.length < 5 || segments[0] !== 'api') {
      return null
    }
    const rest = segments.slice(1)
    if (rest[rest.length - 2] !== 'file') {
      return null
    }
    const file = rest[rest.length - 1]
    const coords = rest.slice(0, -2)
    if (file === undefined || file === '' || file.includes('/')) {
      return null
    }
    if (!pinsIdentity(coords, identity)) {
      return null
    }
    if (!coords.every(cleanSegment)) {
      return null
    }
    return parsed.toString()
  }
  if (host === EXTENSION_ICON_CDN_HOST) {
    // Official asset-host form: /<ns>/<name>[/<platform>]/<version>/<file>
    if (segments.length < 4) {
      return null
    }
    const file = segments[segments.length - 1]
    const coords = segments.slice(0, -1)
    if (file === undefined || file === '' || file.includes('/')) {
      return null
    }
    if (!pinsIdentity(coords, identity)) {
      return null
    }
    if (!coords.every(cleanSegment) || !cleanSegment(file)) {
      return null
    }
    return parsed.toString()
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

export class ExtensionIconService {
  private readonly fetchImpl: IconFetch
  private readonly cache = new Map<string, { readonly id: string; readonly stored: StoredExtensionIcon } | null>()

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
    if (sourceUrl === null) {
      return null
    }
    const validated = validatedIconSourceUrl(sourceUrl, identity)
    if (validated === null) {
      return null
    }
    const cached = this.cache.get(validated)
    if (cached !== undefined) {
      return cached === null ? null : `${EXTENSION_ICON_PROTOCOL}://${cached.id}`
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
        this.cache.delete(oldest.value)
      }
    }
    this.cache.set(validated, outcome)
    return outcome === null ? null : `${EXTENSION_ICON_PROTOCOL}://${outcome.id}`
  }

  /** Cache read for the protocol handler (ID → bytes, throws when unknown). */
  readIconContent(id: string): StoredExtensionIcon {
    for (const entry of this.cache.values()) {
      if (entry !== null && entry.id === id) {
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
          headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
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
      const contentType = parseContentType(response.headers.get('content-type'))
      if (contentType === null) {
        throw new Error('Icon response is not a supported image.')
      }
      const declared = parseByteLength(response.headers.get('content-length'))
      if (declared !== null && declared > EXTENSION_ICON_MAX_BYTES) {
        throw new Error('Icon exceeds the size limit.')
      }
      const bytes = await readBoundedBytes(response.body)
      return {
        id: randomBytes(16).toString('hex'),
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

