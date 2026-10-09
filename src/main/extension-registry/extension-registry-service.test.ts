import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EXTENSION_REGISTRY_MAX_QUERY_LENGTH,
  EXTENSION_REGISTRY_MAX_RESULTS,
  EXTENSION_REGISTRY_TIMEOUT_MS,
  ExtensionRegistryService,
  normalizeExtensionHit,
  OPEN_VSX_BASE_URL,
  validatedIconUrl,
  type RegistryFetch
} from './extension-registry-service'
import { InvalidExtensionRegistryRequestError, toPublicExtensionRegistryError } from './errors'

function okFetch(payload: unknown, calls: string[]): RegistryFetch {
  return async (url: string) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => payload
    }
  }
}

function sampleHit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: 'esbenp',
    name: 'prettier-vscode',
    displayName: 'Prettier - Code formatter',
    description: 'Code formatter using prettier',
    version: '12.4.0',
    downloadCount: 9424900,
    averageRating: 4.35,
    verified: true,
    files: { icon: 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png' },
    ...overrides
  }
}

describe('extension registry bounds', () => {
  it('base URL is main-owned Open VSX with bounded constants', () => {
    assert.equal(OPEN_VSX_BASE_URL, 'https://open-vsx.org')
    assert.equal(EXTENSION_REGISTRY_TIMEOUT_MS, 10_000)
    assert.equal(EXTENSION_REGISTRY_MAX_RESULTS, 20)
    assert.equal(EXTENSION_REGISTRY_MAX_QUERY_LENGTH, 100)
  })

  it('rejects invalid queries without touching the network', async () => {
    const calls: string[] = []
    const service = new ExtensionRegistryService(okFetch({ extensions: [] }, calls))
    for (const bad of ['', '   ', null, undefined, 42, 'x'.repeat(101)]) {
      await assert.rejects(service.search(bad), /1–100/)
    }
    assert.equal(calls.length, 0)
  })

  it('caps results at 20 per request', async () => {
    const calls: string[] = []
    const hits = Array.from({ length: 30 }, (_, index) =>
      sampleHit({ namespace: `pub${index}`, name: `ext${index}` })
    )
    const service = new ExtensionRegistryService(okFetch({ extensions: hits, totalSize: 30 }, calls))
    const result = await service.search('theme')
    assert.equal(result.entries.length, 20)
    assert.equal(result.truncated, true)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]?.includes('size=20'))
    assert.ok((calls[0] ?? '').startsWith('https://open-vsx.org/api/-/search?'))
  })

  it('single attempt with no retries on failure', async () => {
    let calls = 0
    const failing: RegistryFetch = async () => {
      calls += 1
      throw new Error('boom')
    }
    const service = new ExtensionRegistryService(failing)
    await assert.rejects(service.search('theme'), /Registry request failed\./)
    assert.equal(calls, 1)
  })

  it('non-OK statuses stay internal until the binding maps them', async () => {
    const service = new ExtensionRegistryService(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    await assert.rejects(service.search('theme'), /Registry request failed\./)
  })

  it('malformed payloads stay internal until the binding maps them', async () => {
    const service = new ExtensionRegistryService(okFetch({ nope: true }, []))
    await assert.rejects(service.search('theme'), /malformed/)
  })
})

describe('extension hit normalization', () => {
  it('normalizes real registry shapes to renderer metadata', () => {
    const entry = normalizeExtensionHit(sampleHit())
    assert.equal(entry?.id, 'esbenp.prettier-vscode')
    assert.equal(entry?.displayName, 'Prettier - Code formatter')
    assert.equal(entry?.publisher, 'esbenp')
    assert.equal(entry?.downloadCount, 9424900)
    assert.equal(entry?.rating, 4.4)
    assert.equal(entry?.verified, true)
    assert.equal(entry?.iconUrl, 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png')
    assert.ok(!('files' in (entry as unknown as Record<string, unknown>)), 'raw file map must not leak')
  })

  it('drops download URLs and drops unusable hits', () => {
    assert.equal(normalizeExtensionHit(null), null)
    assert.equal(normalizeExtensionHit({ namespace: '', name: 'x' }), null)
    assert.equal(normalizeExtensionHit({ namespace: 'a' }), null)
    const entry = normalizeExtensionHit(sampleHit({ downloadCount: -5, averageRating: 9 }))
    assert.equal(entry?.downloadCount, 0)
    assert.equal(entry?.rating, null)
  })

  it('allows only registry-origin HTTPS icon URLs', () => {
    const good = 'https://open-vsx.org/api/a/b/1.0.0/file/icon.png'
    assert.equal(validatedIconUrl(good), good)
    for (const bad of [
      'http://open-vsx.org/api/a/b/1.0.0/file/icon.png',
      'https://evil.example/icon.png',
      'https://open-vsx.org/other/icon.png',
      '/api/a/b/1.0.0/file/icon.png',
      '',
      null,
      42
    ]) {
      assert.equal(validatedIconUrl(bad), null)
    }
  })

  it('public errors never leak internals', () => {
    for (const error of [new Error('socket hang up'), { status: 500 }, 'nope', null]) {
      assert.equal(toPublicExtensionRegistryError(error).message, 'We couldn’t load extensions.')
    }
    assert.equal(
      toPublicExtensionRegistryError(new InvalidExtensionRegistryRequestError()).message,
      'Search text must be 1–100 characters.'
    )
  })
})

describe('extension featured catalog', () => {
  it('loads the popular catalog without a query', async () => {
    const calls: string[] = []
    const service = new ExtensionRegistryService(okFetch({ extensions: [sampleHit()], totalSize: 1 }, calls))
    const result = await service.listFeatured()
    assert.equal(result.entries.length, 1)
    assert.equal(result.truncated, false)
    assert.equal(calls.length, 1)
    const url = calls[0] ?? ''
    assert.ok(url.includes('sortBy=downloadCount'), 'default catalog must prefer popular ordering')
    assert.ok(!url.includes('query='), 'default catalog must not invent query text')
  })
})
