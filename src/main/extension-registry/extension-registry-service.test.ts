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
import { buildCspPolicy } from '../security/csp'

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

  it('retains legitimate inspected Open VSX icon URLs', () => {
    // Exact icon forms returned live by /api/-/search (featured,
    // query=python, query=eslint): absolute registry file URLs.
    for (const good of [
      'https://open-vsx.org/api/meta/pyrefly/alpine-arm64/1.3.9003/file/pyrefly-symbol.png',
      'https://open-vsx.org/api/ms-python/debugpy/darwin-arm64/2026.6.0/file/icon.png',
      'https://open-vsx.org/api/ms-python/python/2026.4.0/file/icon.png',
      'https://open-vsx.org/api/dbaeumer/vscode-eslint/3.0.34/file/eslint_icon.png',
      'https://open-vsx.org/api/manuth/eslint-language-service/1.1.3/file/Icon.png',
      'https://open-vsx.org/api/a/b/1.0.0/file/icon.png'
    ]) {
      assert.equal(validatedIconUrl(good), good)
    }
  })

  it('resolves relative registry resources against the fixed origin', () => {
    assert.equal(
      validatedIconUrl('/api/a/b/1.0.0/file/icon.png'),
      'https://open-vsx.org/api/a/b/1.0.0/file/icon.png'
    )
  })

  it('rejects non-allowlisted icon URLs', () => {
    for (const bad of [
      'http://open-vsx.org/api/a/b/1.0.0/file/icon.png',
      'https://evil.example/icon.png',
      'https://open-vsx.org.evil.example/api/x/file/icon.png',
      'https://user:pass@open-vsx.org/api/x/file/icon.png',
      'https://open-vsx.org:8443/api/x/file/icon.png',
      'javascript:alert(1)',
      'file:///etc/icon.png',
      'blob:https://open-vsx.org/uuid',
      'data:image/png;base64,AAA',
      '//evil.example/x.png',
      'https://open-vsx.org/other/icon.png',
      'https://open-vsx.org/vscode/unpkg/a/b/icon.png',
      'https://open-vsx.org/api/../evil.png',
      'https://open-vsx.org/api/%2e%2e/evil.png',
      '',
      null,
      42
    ]) {
      assert.equal(validatedIconUrl(bad), null)
    }
  })

  it('carries retained icon URLs through normalization', () => {
    const entry = normalizeExtensionHit(
      sampleHit({ files: { icon: 'https://open-vsx.org/api/ms-python/python/2026.4.0/file/icon.png' } })
    )
    assert.equal(entry?.iconUrl, 'https://open-vsx.org/api/ms-python/python/2026.4.0/file/icon.png')
    const missing = normalizeExtensionHit(sampleHit({ files: {} }))
    assert.equal(missing?.iconUrl, null)
  })

  it('CSP names the main-owned icon scheme and no remote image origin', () => {
    // Stabilization pass: icons render via opaque
    // stark-extension-icon:// IDs served by main, so no remote image
    // host may appear in img-src (the Open VSX 302 to its asset host
    // is followed main-side, never by renderer <img>).
    const prod = buildCspPolicy(true, undefined)
    assert.ok(prod.includes('img-src'), 'production policy must carry img-src')
    assert.ok(prod.includes('stark-extension-icon:'), 'production img-src must name the main-owned icon scheme')
    assert.ok(!prod.includes('https://open-vsx.org'), 'production img-src must not name remote image origins')
    assert.ok(!prod.includes('*'), 'production CSP must not wildcard')
    const dev = buildCspPolicy(false, 'http://localhost:5173/')
    assert.ok(dev.includes('stark-extension-icon:'), 'dev img-src must name the icon scheme or icons cannot load')
    const devTokens = dev.split(/[;\s]+/)
    assert.ok(!devTokens.includes('https:'), 'dev CSP must not open image loading to arbitrary HTTPS hosts')
    assert.ok(!devTokens.some((token) => token.startsWith('*.')), 'dev CSP must not wildcard hosts')
    assert.ok(!devTokens.includes('https://open-vsx.org'), 'dev img-src must not name remote image origins')
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

describe('extension icon resolution (main-owned delivery)', () => {
  it('maps validated sources to opaque URLs through the injected resolver', async () => {
    const seen: { source: string | null; namespace: string; name: string; version: string }[] = []
    const service = new ExtensionRegistryService(okFetch({ extensions: [sampleHit()], totalSize: 1 }, []), {
      resolveIcon: async (sourceUrl, identity) => {
        seen.push({ source: sourceUrl, ...identity })
        return 'stark-extension-icon://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      }
    })
    const result = await service.search('prettier')
    assert.equal(result.entries[0]?.iconUrl, 'stark-extension-icon://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    assert.deepEqual(seen, [
      {
        source: 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png',
        namespace: 'esbenp',
        name: 'prettier-vscode',
        version: '12.4.0'
      }
    ])
  })

  it('keeps the catalog delivery working when one icon genuinely fails', async () => {
    const service = new ExtensionRegistryService(
      okFetch(
        {
          extensions: [
            sampleHit(),
            sampleHit({
              namespace: 'other',
              name: 'ext',
              files: { icon: 'https://open-vsx.org/api/other/ext/1.0.0/file/icon.png' }
            })
          ],
          totalSize: 2
        },
        []
      ),
      {
        resolveIcon: async (sourceUrl) =>
          sourceUrl?.includes('esbenp') === true ? 'stark-extension-icon://cccccccccccccccccccccccccccccccc' : null
      }
    )
    const result = await service.search('prettier')
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[0]?.iconUrl, 'stark-extension-icon://cccccccccccccccccccccccccccccccc')
    assert.equal(result.entries[1]?.iconUrl, null)
  })

  it('passes remote validated URLs through when no resolver is injected', async () => {
    const service = new ExtensionRegistryService(okFetch({ extensions: [sampleHit()], totalSize: 1 }, []))
    const result = await service.search('prettier')
    assert.equal(result.entries[0]?.iconUrl, 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png')
  })
})
