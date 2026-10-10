import { lookup } from 'node:dns/promises'
import { lstatSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * Generic `contributes.jsonValidation` runtime (main-side).
 *
 * Implements the stable VS Code contribution generically — no
 * per-extension special cases. Two schema-source classes:
 *
 * - Extension-local (`./package-json-schema.json`, `schemas/x.json`):
 *   resolved ONLY within that installed extension's directory.
 *   Containment is mandatory (no `..`, no absolute, no drive/UNC);
 *   reads are bounded (256 KiB) and must parse to a JSON object.
 * - Remote (`https://...`): main-owned bounded fetch ONLY (the
 *   renderer never performs schema networking). HTTPS only, 10s
 *   timeout, at most 256 KiB, at most 3 redirects (every hop
 *   re-validated: HTTPS, no credentials, no non-default port), no
 *   retries, no cookies/credentials, and a best-effort SSRF guard
 *   that refuses loopback/private/link-local/reserved targets
 *   (TOCTOU is acknowledged: DNS is re-checked per hop, but a
 *   rotating record can still shift between check and connect —
 *   the fetch carries no credentials either way).
 *
 * Unregistering is structural: schemas derive from the currently
 * enabled installed manifests on every call, so disable/uninstall
 * drops that owner's entries without a separate code path.
 */

/** Maximum schema bytes read (local) or fetched (remote). */
export const JSON_SCHEMA_MAX_BYTES = 256 * 1024

/** Single-attempt network bound per remote schema (redirect hops share it). */
export const JSON_SCHEMA_TIMEOUT_MS = 10_000

/** Maximum validated redirect hops per remote schema. */
export const JSON_SCHEMA_MAX_REDIRECTS = 3

/** Maximum merged schemas returned per call (bounded). */
export const JSON_SCHEMA_MAX_MERGED = 64

export interface ValidatedJsonSchemaRef {
  readonly fileMatch: readonly string[]
  readonly url: string
}

export interface ResolvedJsonSchema {
  /** Owning extension instance id (`ns.name@version`) — removal key. */
  readonly owner: string
  readonly fileMatch: readonly string[]
  readonly url: string
  /** Inline schema object for Monaco (absent when unresolvable offline). */
  readonly schema: Record<string, unknown> | null
}

/** Minimal fetch shape (global fetch in production, fakes in tests). */
export type SchemaFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect?: 'manual' }
) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: unknown
}>

/**
 * Whether a jsonValidation `url` is extension-local (relative path).
 * Absolute URLs with any scheme, absolute paths, drive/UNC forms,
 * and protocol-relative refs are NOT local.
 */
export function isLocalSchemaUrl(url: string): boolean {
  if (url === '' || url.includes('\0')) {
    return false
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    return false
  }
  if (url.startsWith('/') || url.startsWith('\\') || /^[A-Za-z]:/.test(url) || url.startsWith('//')) {
    return false
  }
  return true
}

/**
 * Resolves an extension-local schema reference to an absolute path
 * strictly under the extension directory, or null. `./` prefixes
 * are stripped; `..` anywhere rejects.
 */
export function resolveLocalSchemaPath(extensionDir: string, url: string): string | null {
  if (!isLocalSchemaUrl(url)) {
    return null
  }
  const trimmed = url.startsWith('./') ? url.slice(2) : url
  if (trimmed === '' || trimmed.length > 512) {
    return null
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '..') {
      return null
    }
  }
  const root = resolve(extensionDir)
  const candidate = resolve(root, trimmed)
  const relativePath = relative(root, candidate)
  if (relativePath === '' || relativePath.startsWith('..') || resolve(root, relativePath) !== candidate) {
    return null
  }
  // Extra guard on Windows-style separators smuggled through split.
  if (candidate.includes('\\') && sep === '/' && /\\/.test(trimmed)) {
    return null
  }
  return candidate
}

/** Reads one local schema file as data (bounded, must be a JSON object). */
export function readLocalJsonSchema(extensionDir: string, url: string): Record<string, unknown> | null {
  const absolute = resolveLocalSchemaPath(extensionDir, url)
  if (absolute === null) {
    return null
  }
  let size: number
  try {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null
    }
    size = stat.size
  } catch {
    return null
  }
  if (size <= 0 || size > JSON_SCHEMA_MAX_BYTES) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(absolute, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Strict remote schema URL validation (pure): HTTPS only, no
 * credentials, no non-default port, bounded length. Queries are
 * allowed (schema CDNs use them); fragments are dropped by fetch.
 */
export function validatedRemoteSchemaUrl(value: string): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 512 || value.includes('\0')) {
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
  return parsed.toString()
}

/** Exported for unit tests: whether a resolved literal address is refused (SSRF guard). */
export function isBlockedSchemaAddress(address: string): boolean {
  return isBlockedAddress(address)
}

function isBlockedAddress(address: string): boolean {  const lower = address.toLowerCase()
  // IPv4: loopback, private, link-local, reserved, multicast.
  if (/^127\./.test(lower) || lower === '0.0.0.0') {
    return true
  }
  const v4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4 !== null) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 10) {
      return true
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true
    }
    if (a === 192 && b === 168) {
      return true
    }
    if (a === 169 && b === 254) {
      return true
    }
    // Carrier-grade NAT shared space (100.64.0.0/10).
    if (a === 100 && b >= 64 && b <= 127) {
      return true
    }
    if (a >= 224) {
      return true
    }
  }
  // IPv6: loopback, unspecified, link-local, unique-local, multicast.
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fec0:')) {
    return true
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  }
  if (lower.startsWith('ff')) {
    return true
  }
  return false
}

/** Best-effort SSRF guard: every resolved address must be public. */
async function assertPublicHost(hostname: string): Promise<void> {
  let records: { address: string }[]
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    throw new Error('Schema host does not resolve.')
  }
  if (records.length === 0) {
    throw new Error('Schema host does not resolve.')
  }
  for (const record of records.slice(0, 16)) {
    if (isBlockedAddress(record.address)) {
      throw new Error('Schema host is not reachable.')
    }
  }
}

async function readBoundedJson(body: unknown): Promise<unknown> {
  if (body === null || typeof body !== 'object') {
    throw new Error('Schema response has no body.')
  }
  const stream = body as AsyncIterable<unknown>
  if (typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('Schema response has no body.')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > JSON_SCHEMA_MAX_BYTES) {
      throw new Error('Schema exceeds its bound.')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

/**
 * Main-owned bounded remote schema fetch (single attempt, no
 * retries). Returns the parsed schema object, or null when anything
 * is invalid, unreachable, oversized, or non-JSON. Never throws
 * outward with internals (callers treat null as "unavailable
 * offline" and skip the entry). The host check is injectable so
 * unit tests never touch DNS.
 */
export async function fetchRemoteJsonSchema(
  url: string,
  fetchImpl?: SchemaFetch,
  checkHost: (hostname: string) => Promise<void> = assertPublicHost
): Promise<Record<string, unknown> | null> {
  const fetchFn = fetchImpl ?? (globalThis.fetch as unknown as SchemaFetch)
  let current = validatedRemoteSchemaUrl(url)
  if (current === null) {
    return null
  }
  try {
    for (let hop = 0; hop <= JSON_SCHEMA_MAX_REDIRECTS; hop += 1) {
      const allowed = validatedRemoteSchemaUrl(current)
      if (allowed === null) {
        return null
      }
      try {
        await checkHost(new URL(allowed).hostname)
      } catch {
        return null
      }
      let response: { readonly ok: boolean; readonly status: number; readonly headers: { get(name: string): string | null }; readonly body: unknown }
      try {
        response = await fetchFn(allowed, {
          headers: { Accept: 'application/schema+json, application/json' },
          signal: AbortSignal.timeout(JSON_SCHEMA_TIMEOUT_MS),
          redirect: 'manual'
        })
      } catch {
        return null
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') {
          return null
        }
        try {
          current = new URL(location, allowed).toString()
        } catch {
          return null
        }
        continue
      }
      if (!response.ok) {
        return null
      }
      const lengthRaw = response.headers.get('content-length')
      if (lengthRaw !== null && lengthRaw !== '') {
        const length = Number(lengthRaw)
        if (!Number.isInteger(length) || length < 0 || length > JSON_SCHEMA_MAX_BYTES) {
          return null
        }
      }
      let parsed: unknown
      try {
        parsed = await readBoundedJson(response.body)
      } catch {
        return null
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null
      }
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/**
 * Expands one fileMatch list into Monaco-compatible patterns.
 * VS Code matches bare filenames (`package.json`) against any such
 * file; Monaco matches patterns against the model URI, so bare
 * names gain an explicit `**\/<name>` companion. Patterns already
 * carrying glob magic or slashes pass through untouched. Bounded
 * and deterministic.
 */
export function toMonacoFilePatterns(fileMatch: readonly string[]): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pattern of fileMatch.slice(0, 8)) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 256) {
      continue
    }
    if (!seen.has(pattern)) {
      seen.add(pattern)
      out.push(pattern)
    }
    const bare = !pattern.includes('/') && !pattern.includes('\\') && !/[*?[{]/.test(pattern)
    if (bare) {
      const expanded = `**/${pattern}`
      if (!seen.has(expanded)) {
        seen.add(expanded)
        out.push(expanded)
      }
    }
    if (out.length >= 16) {
      break
    }
  }
  return out
}
