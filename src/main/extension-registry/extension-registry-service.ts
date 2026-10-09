import type { ExtensionEntry, ExtensionSearchResult } from '../../shared/extension-registry/types'
import { ExtensionRegistryError, InvalidExtensionRegistryRequestError } from './errors'

/**
 * Main-owned Open VSX catalog service (display only).
 *
 * The ONLY place the Open VSX base URL lives: renderers never see it
 * and can never choose an arbitrary URL — they send query text (or
 * nothing) and receive normalized metadata. Exactly one network
 * request per call, 10s timeout, zero retries, no polling, no
 * pagination, at most 20 entries. No install/download/host surface.
 */

/** Fixed registry origin. Never renderer-supplied. */
export const OPEN_VSX_BASE_URL = 'https://open-vsx.org'

/** Single-attempt network bound per request. */
export const EXTENSION_REGISTRY_TIMEOUT_MS = 10_000

/** Maximum normalized entries returned per request. */
export const EXTENSION_REGISTRY_MAX_RESULTS = 20

/** Renderer query text bound (characters after trimming). */
export const EXTENSION_REGISTRY_MAX_QUERY_LENGTH = 100

/** Normalized description bound (characters). */
export const EXTENSION_REGISTRY_MAX_DESCRIPTION_LENGTH = 300

/** Minimal fetch shape (global fetch in production, fakes in tests). */
export type RegistryFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>

function validatedQuery(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidExtensionRegistryRequestError()
  }
  const query = value.trim()
  if (query.length === 0 || query.length > EXTENSION_REGISTRY_MAX_QUERY_LENGTH) {
    throw new InvalidExtensionRegistryRequestError()
  }
  return query
}

/**
 * Icon allowlist: absolute HTTPS URLs on the registry origin under
 * its API file path only. Anything else (relative paths, other
 * hosts, non-HTTPS) normalizes to null and the renderer falls back
 * to its local generic icon.
 */
export function validatedIconUrl(value: unknown): string | null {
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
  if (parsed.hostname.toLowerCase() !== 'open-vsx.org') {
    return null
  }
  if (!parsed.pathname.startsWith('/api/')) {
    return null
  }
  return parsed.toString()
}

function asText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed === '') {
    return fallback
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed
}

function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

function asRating(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  if (value < 0 || value > 5) {
    return null
  }
  return Math.round(value * 10) / 10
}

/**
 * Normalizes one raw registry hit to renderer-safe metadata, or null
 * when the hit lacks a usable namespace/name identity. Download URLs,
 * signatures, and every other raw field are dropped here and never
 * cross IPC.
 */
export function normalizeExtensionHit(hit: unknown): ExtensionEntry | null {
  if (typeof hit !== 'object' || hit === null) {
    return null
  }
  const record = hit as Record<string, unknown>
  const namespace = typeof record['namespace'] === 'string' ? record['namespace'].trim() : ''
  const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
  if (namespace === '' || name === '') {
    return null
  }
  const files = record['files']
  const iconRaw =
    typeof files === 'object' && files !== null ? (files as Record<string, unknown>)['icon'] : null
  return {
    id: `${namespace}.${name}`,
    displayName: asText(record['displayName'], name, EXTENSION_REGISTRY_MAX_QUERY_LENGTH),
    publisher: asText(namespace, namespace, EXTENSION_REGISTRY_MAX_QUERY_LENGTH),
    description: asText(record['description'], 'No description provided.', EXTENSION_REGISTRY_MAX_DESCRIPTION_LENGTH),
    version: asText(record['version'], 'unknown', 32),
    downloadCount: asCount(record['downloadCount']),
    rating: asRating(record['averageRating']),
    iconUrl: validatedIconUrl(iconRaw),
    verified: record['verified'] === true
  }
}

function buildSearchUrl(query: string): string {
  const url = new URL('/api/-/search', OPEN_VSX_BASE_URL)
  url.searchParams.set('query', query)
  url.searchParams.set('size', String(EXTENSION_REGISTRY_MAX_RESULTS))
  return url.toString()
}

function buildFeaturedUrl(): string {
  const url = new URL('/api/-/search', OPEN_VSX_BASE_URL)
  url.searchParams.set('size', String(EXTENSION_REGISTRY_MAX_RESULTS))
  url.searchParams.set('sortBy', 'downloadCount')
  url.searchParams.set('sortOrder', 'desc')
  return url.toString()
}

export class ExtensionRegistryService {
  private readonly fetchImpl: RegistryFetch

  constructor(fetchImpl: RegistryFetch = globalThis.fetch as unknown as RegistryFetch) {
    this.fetchImpl = fetchImpl
  }

  /** Text search over the registry (one bounded request, no retries). */
  async search(rawQuery: unknown): Promise<ExtensionSearchResult> {
    const query = validatedQuery(rawQuery)
    return this.fetchCatalog(buildSearchUrl(query))
  }

  /** Default popular catalog for the empty-query state. */
  async listFeatured(): Promise<ExtensionSearchResult> {
    return this.fetchCatalog(buildFeaturedUrl())
  }

  private async fetchCatalog(url: string): Promise<ExtensionSearchResult> {
    let response: { readonly ok: boolean; readonly status: number; json(): Promise<unknown> }
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(EXTENSION_REGISTRY_TIMEOUT_MS)
      })
    } catch (error: unknown) {
      throw new ExtensionRegistryError('Registry request failed.', { cause: error })
    }
    if (!response.ok) {
      throw new ExtensionRegistryError('Registry request failed.')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new ExtensionRegistryError('Registry response was malformed.', { cause: error })
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new ExtensionRegistryError('Registry response was malformed.')
    }
    const record = payload as Record<string, unknown>
    const rawEntries = record['extensions']
    if (!Array.isArray(rawEntries)) {
      throw new ExtensionRegistryError('Registry response was malformed.')
    }
    const totalSize = typeof record['totalSize'] === 'number' ? record['totalSize'] : rawEntries.length
    const entries: ExtensionEntry[] = []
    for (const hit of rawEntries) {
      if (entries.length >= EXTENSION_REGISTRY_MAX_RESULTS) {
        break
      }
      const entry = normalizeExtensionHit(hit)
      if (entry !== null) {
        entries.push(entry)
      }
    }
    return { entries, truncated: totalSize > entries.length }
  }
}
