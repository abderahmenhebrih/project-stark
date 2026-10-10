import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_ICON_CDN_HOST,
  EXTENSION_ICON_MAX_BYTES,
  EXTENSION_ICON_TIMEOUT_MS,
  ExtensionIconService,
  deterministicIconId,
  validateSvgIconBytes,
  validatedIconSourceUrl,
  type IconFetch
} from './extension-icon-service'
import { EXTENSION_ICON_PROTOCOL, parseExtensionIconUrl, serveExtensionIconRequest } from './protocol'

const IDENTITY = { namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    lower[key.toLowerCase()] = value
  }
  return { get: (name: string) => lower[name.toLowerCase()] ?? null }
}

function bodyOf(text: string): unknown {
  const buffer = Buffer.from(text, 'utf8')
  async function* chunks(): AsyncGenerator<Buffer> {
    yield buffer
  }
  return chunks()
}

function bodyOfBytes(bytes: Buffer): unknown {
  async function* chunks(): AsyncGenerator<Buffer> {
    yield bytes
  }
  return chunks()
}

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('icon-bytes')])
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from('icon-bytes')])

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: unknown
}

function fakeFetch(handler: (url: string) => FakeResponse): IconFetch & { calls: string[] } {
  const calls: string[] = []
  const inner = async (url: string): Promise<FakeResponse> => {
    calls.push(url)
    return handler(url)
  }
  const fetch = inner as unknown as IconFetch & { calls: string[] }
  fetch.calls = calls
  return fetch
}

const PNG_HEADERS = { 'content-type': 'image/png', 'content-length': '4' }

describe('icon source validation (identity-pinned)', () => {
  it('accepts registry and official asset-host forms for the catalog identity', () => {
    assert.equal(
      validatedIconSourceUrl('https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png', IDENTITY),
      'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    )
    assert.equal(
      validatedIconSourceUrl(
        'https://open-vsx.org/api/meta/pyrefly/alpine-arm64/1.3.9003/file/pyrefly-symbol.png',
        { namespace: 'meta', name: 'pyrefly', version: '1.3.9003' }
      ),
      'https://open-vsx.org/api/meta/pyrefly/alpine-arm64/1.3.9003/file/pyrefly-symbol.png'
    )
    assert.equal(
      validatedIconSourceUrl('https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png', IDENTITY),
      'https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png'
    )
  })

  it('pins the exact asset host with no wildcard or subdomain allowance', () => {
    assert.equal(EXTENSION_ICON_CDN_HOST, 'openvsx.eclipsecontent.org')
    for (const bad of [
      'https://evil.example/esbenp/prettier-vscode/12.4.0/icon.png',
      'https://openvsx.eclipsecontent.org.evil.example/esbenp/prettier-vscode/12.4.0/icon.png',
      'https://sub.openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png',
      'https://open-vsx.org.evil.example/api/x/file/icon.png'
    ]) {
      assert.equal(validatedIconSourceUrl(bad, IDENTITY), null)
    }
  })

  it('rejects identity mismatches, traversal, credentials, ports, and queries', () => {
    for (const bad of [
      'https://openvsx.eclipsecontent.org/other/prettier-vscode/12.4.0/icon.png',
      'https://openvsx.eclipsecontent.org/esbenp/other/12.4.0/icon.png',
      'https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/9.9.9/icon.png',
      'https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/../evil.png',
      'https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png?x=1',
      'https://user:pass@openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png',
      'https://openvsx.eclipsecontent.org:8443/esbenp/prettier-vscode/12.4.0/icon.png',
      'http://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png',
      'https://open-vsx.org/other/icon.png',
      'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/icon.png',
      '',
      null,
      42
    ]) {
      assert.equal(validatedIconSourceUrl(bad, IDENTITY), null)
    }
  })
})

describe('icon resolution (bounded, single attempt)', () => {
  it('follows the official 302 to opaque bytes served by ID only', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    const cdn = 'https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/icon.png'
    const fetch = fakeFetch((url) => {
      if (url === source) {
        return { ok: false, status: 302, headers: headers({ location: cdn }), body: bodyOf('') }
      }
      assert.equal(url, cdn)
      return { ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOf('PNG!') }
    })
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, IDENTITY)
    assert.ok(opaque?.startsWith(`${EXTENSION_ICON_PROTOCOL}://`), 'renderer must receive only an opaque URL')
    assert.ok(!String(opaque).includes('open-vsx.org'), 'no remote URL may leak to the renderer')
    assert.ok(!String(opaque).includes('eclipsecontent'), 'no asset-host URL may leak to the renderer')
    assert.equal(fetch.calls.length, 2)
    const response = serveExtensionIconRequest(String(opaque), (id) => service.readIconContent(id))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(await response.text(), 'PNG!')
  })

  it('uses one bounded attempt: timeout constant, zero retries, 2 MiB cap', () => {
    assert.equal(EXTENSION_ICON_TIMEOUT_MS, 10_000)
    assert.equal(EXTENSION_ICON_MAX_BYTES, 2 * 1024 * 1024)
  })

  it('falls back once on hostile redirects, wrong types, oversize, and errors', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    async function resolves(handler: (url: string) => FakeResponse): Promise<{ opaque: string | null; calls: number }> {
      const fetch = fakeFetch(handler)
      const service = new ExtensionIconService(fetch)
      return { opaque: await service.resolveIcon(source, IDENTITY), calls: fetch.calls.length }
    }
    // Hostile redirect target.
    assert.equal(
      (
        await resolves(() => ({
          ok: false,
          status: 302,
          headers: headers({ location: 'https://evil.example/icon.png' }),
          body: bodyOf('')
        }))
      ).opaque,
      null
    )
    // Malicious SVG rejected (strict validator, never served).
    assert.equal(
      (
        await resolves(() => ({
          ok: true,
          status: 200,
          headers: headers({ 'content-type': 'image/svg+xml' }),
          body: bodyOf('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
        }))
      ).opaque,
      null
    )
    // HTML rejected.
    assert.equal(
      (await resolves(() => ({ ok: true, status: 200, headers: headers({ 'content-type': 'text/html' }), body: bodyOf('<html/>') }))).opaque,
      null
    )
    // Declared oversize rejected before streaming.
    assert.equal(
      (
        await resolves(() => ({
          ok: true,
          status: 200,
          headers: headers({ 'content-type': 'image/png', 'content-length': String(EXTENSION_ICON_MAX_BYTES + 1) }),
          body: bodyOf('x')
        }))
      ).opaque,
      null
    )
    // Server errors resolve to null, not throws.
    assert.equal((await resolves(() => ({ ok: false, status: 500, headers: headers({}), body: bodyOf('') }))).opaque, null)
  })

  it('caches successes and failures without reload loops', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOf('PNG!') }))
    const service = new ExtensionIconService(fetch)
    const first = await service.resolveIcon(source, IDENTITY)
    const second = await service.resolveIcon(source, IDENTITY)
    assert.equal(first, second)
    assert.equal(fetch.calls.length, 1)
    const failing = fakeFetch(() => {
      throw new Error('down')
    })
    const failingService = new ExtensionIconService(failing)
    assert.equal(await failingService.resolveIcon(source, IDENTITY), null)
    assert.equal(await failingService.resolveIcon(source, IDENTITY), null)
    assert.equal(failing.calls.length, 1)
  })

  it('accepts only image/png, image/jpeg, image/webp, image/gif, image/x-icon, image/svg+xml', async () => {
    for (const contentType of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/x-icon',
      'image/svg+xml',
      'image/png; charset=binary'
    ]) {
      const body =
        contentType.startsWith('image/svg') || contentType === 'image/x-icon'
          ? contentType === 'image/x-icon'
            ? bodyOfBytes(Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.from('icon-bytes')]))
            : bodyOf('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>')
          : bodyOf('x')
      const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({ 'content-type': contentType }), body }))
      const service = new ExtensionIconService(fetch)
      const opaque = await service.resolveIcon(
        'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png',
        IDENTITY
      )
      assert.ok(opaque !== null, contentType)
    }
  })

  it('renders the observed meta-namespace icon form end to end (Pyrefly case)', async () => {
    // Live Open VSX serves this entry as /api/meta/<ns>/<platform>/
    // <version>/file/<file> and 302-redirects to the matching /meta/
    // CDN path with Content-Type application/octet-stream over real
    // PNG bytes. All three legs must resolve to one opaque icon.
    const identity = { namespace: 'meta', name: 'pyrefly', version: '1.3.9003' }
    const source = 'https://open-vsx.org/api/meta/pyrefly/alpine-arm64/1.3.9003/file/pyrefly-symbol.png'
    const cdn = 'https://openvsx.eclipsecontent.org/meta/pyrefly/alpine-arm64/1.3.9003/pyrefly-symbol.png'
    const fetch = fakeFetch((url) => {
      if (url === source) {
        return { ok: false, status: 302, headers: headers({ location: cdn }), body: bodyOf('') }
      }
      assert.equal(url, cdn)
      return { ok: true, status: 200, headers: headers({ 'content-type': 'application/octet-stream' }), body: bodyOfBytes(PNG_BYTES) }
    })
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, identity)
    assert.ok(opaque?.startsWith(`${EXTENSION_ICON_PROTOCOL}://`), 'renderer must receive only an opaque URL')
    assert.ok(!String(opaque).includes('open-vsx.org'), 'no remote URL may leak to the renderer')
    assert.equal(fetch.calls.length, 2)
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    const stored = service.readIconContent(id)
    assert.equal(stored.contentType, 'image/png')
    assert.ok(Buffer.from(stored.bytes).equals(PNG_BYTES), 'exact validated bytes must be served')
  })

  it('sniffs octet-stream bodies: raster accepted, junk rejected, safe SVG accepted', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    async function resolvesOctetStream(body: unknown): Promise<string | null> {
      const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({ 'content-type': 'application/octet-stream' }), body }))
      return new ExtensionIconService(fetch).resolveIcon(source, IDENTITY)
    }
    const png = await resolvesOctetStream(bodyOfBytes(PNG_BYTES))
    assert.ok(png !== null, 'octet-stream over real PNG bytes must render')
    assert.equal(await resolvesOctetStream(bodyOf('not-an-image')), null)
    const safeSvg = await resolvesOctetStream(
      bodyOf('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>')
    )
    assert.ok(safeSvg !== null, 'octet-stream over safe SVG must render through the strict validator')
    assert.equal(
      await resolvesOctetStream(bodyOf('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')),
      null,
      'malicious SVG over octet-stream must fall back'
    )
  })

  it('prefers sniffed magic over a mismatched declaration', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({ 'content-type': 'image/png' }), body: bodyOfBytes(GIF_BYTES) }))
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, IDENTITY)
    assert.ok(opaque !== null)
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    assert.equal(service.readIconContent(id).contentType, 'image/gif')
  })
})

describe('icon source validation (corrective pass: observed catalog forms)', () => {
  it('accepts retina @2x filenames observed live (logo@128.png, informix_icon_big@2x.png)', () => {
    assert.equal(
      validatedIconSourceUrl(
        'https://open-vsx.org/api/lex/lex-vscode/darwin-arm64/0.10.7/file/logo@128.png',
        { namespace: 'lex', name: 'lex-vscode', version: '0.10.7' }
      ),
      'https://open-vsx.org/api/lex/lex-vscode/darwin-arm64/0.10.7/file/logo@128.png'
    )
    assert.equal(
      validatedIconSourceUrl(
        'https://openvsx.eclipsecontent.org/lex/lex-vscode/darwin-arm64/0.10.7/logo@128.png',
        { namespace: 'lex', name: 'lex-vscode', version: '0.10.7' }
      ),
      'https://openvsx.eclipsecontent.org/lex/lex-vscode/darwin-arm64/0.10.7/logo@128.png'
    )
  })

  it('accepts nested icon asset paths under the file marker with identity still pinned', () => {
    assert.equal(
      validatedIconSourceUrl(
        'https://open-vsx.org/api/acme/theme/1.0.0/file/images/icon.png',
        { namespace: 'acme', name: 'theme', version: '1.0.0' }
      ),
      'https://open-vsx.org/api/acme/theme/1.0.0/file/images/icon.png'
    )
    assert.equal(
      validatedIconSourceUrl('https://openvsx.eclipsecontent.org/acme/theme/1.0.0/images/icon.png', {
        namespace: 'acme',
        name: 'theme',
        version: '1.0.0'
      }),
      'https://openvsx.eclipsecontent.org/acme/theme/1.0.0/images/icon.png'
    )
    // Identity still pinned on nested forms.
    assert.equal(
      validatedIconSourceUrl('https://openvsx.eclipsecontent.org/other/theme/1.0.0/images/icon.png', {
        namespace: 'acme',
        name: 'theme',
        version: '1.0.0'
      }),
      null
    )
  })

  it('rejects encoded separators that decode to traversal', () => {
    assert.equal(
      validatedIconSourceUrl('https://openvsx.eclipsecontent.org/esbenp/prettier-vscode/12.4.0/..%2Fevil.png', IDENTITY),
      null
    )
    assert.equal(
      validatedIconSourceUrl(
        'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/..%2Fevil.png',
        IDENTITY
      ),
      null
    )
  })

  it('resolves retina CDN icons end to end', async () => {
    const identity = { namespace: 'lex', name: 'lex-vscode', version: '0.10.7' }
    const source = 'https://open-vsx.org/api/lex/lex-vscode/darwin-arm64/0.10.7/file/logo@128.png'
    const cdn = 'https://openvsx.eclipsecontent.org/lex/lex-vscode/darwin-arm64/0.10.7/logo@128.png'
    const fetch = fakeFetch((url) => {
      if (url === source) {
        return { ok: false, status: 302, headers: headers({ location: cdn }), body: bodyOf('') }
      }
      assert.equal(url, cdn)
      return { ok: true, status: 200, headers: headers({ 'content-type': 'application/octet-stream' }), body: bodyOfBytes(PNG_BYTES) }
    })
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, identity)
    assert.ok(opaque?.startsWith(`${EXTENSION_ICON_PROTOCOL}://`))
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    assert.equal(service.readIconContent(id).contentType, 'image/png')
  })
})

describe('safe SVG icon support (strict validation, served only via the opaque protocol)', () => {
  const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>'

  it('accepts a minimal safe SVG document', () => {
    assert.ok(validateSvgIconBytes(Buffer.from(SAFE_SVG, 'utf8')) !== null)
  })

  it('accepts an XML preamble and comments before the svg root', () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?><!-- icon -->' + SAFE_SVG
    assert.ok(validateSvgIconBytes(Buffer.from(svg, 'utf8')) !== null)
  })

  it('rejects executable and externally-referencing SVG content', () => {
    const bad = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil.example/x.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.example/x.css"</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/x)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><?php echo 1; ?></svg>',
      '<html><svg></svg></html>',
      'not svg at all'
    ]
    for (const svg of bad) {
      assert.equal(validateSvgIconBytes(Buffer.from(svg, 'utf8')), null, svg.slice(0, 60))
    }
  })

  it('serves valid safe SVG end to end as image/svg+xml, malicious SVG falls back', async () => {
    const source = 'https://open-vsx.org/api/acme/icons/1.0.0/file/icon.svg'
    const identity = { namespace: 'acme', name: 'icons', version: '1.0.0' }
    const safe = fakeFetch(() => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/svg+xml' }),
      body: bodyOf(SAFE_SVG)
    }))
    const safeService = new ExtensionIconService(safe)
    const opaque = await safeService.resolveIcon(source, identity)
    assert.ok(opaque?.startsWith(`${EXTENSION_ICON_PROTOCOL}://`))
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    const stored = safeService.readIconContent(id)
    assert.equal(stored.contentType, 'image/svg+xml')
    assert.equal(Buffer.from(stored.bytes).toString('utf8'), SAFE_SVG)
    const evil = fakeFetch(() => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'image/svg+xml' }),
      body: bodyOf('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    }))
    assert.equal(await new ExtensionIconService(evil).resolveIcon(source, identity), null)
  })

  it('accepts safe SVG over generic bytes (octet-stream, binary alias, missing type)', async () => {
    const source = 'https://open-vsx.org/api/acme/icons/1.0.0/file/icon.svg'
    const identity = { namespace: 'acme', name: 'icons', version: '1.0.0' }
    for (const contentType of ['application/octet-stream', 'binary/octet-stream']) {
      const fetch = fakeFetch(() => ({
        ok: true,
        status: 200,
        headers: headers({ 'content-type': contentType }),
        body: bodyOf(SAFE_SVG)
      }))
      assert.ok((await new ExtensionIconService(fetch).resolveIcon(source, identity)) !== null, contentType)
    }
    const missing = fakeFetch(() => ({ ok: true, status: 200, headers: headers({}), body: bodyOf(SAFE_SVG) }))
    assert.ok((await new ExtensionIconService(missing).resolveIcon(source, identity)) !== null, 'missing type')
  })
})

describe('ICO + missing-type raster forms', () => {
  const ICO_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.from('icon-bytes')])

  it('serves the observed extension_icon.ico form as image/x-icon', async () => {
    const identity = { namespace: 'acme', name: 'icons', version: '0.0.1' }
    const source = 'https://open-vsx.org/api/acme/icons/0.0.1/file/extension_icon.ico'
    assert.equal(validatedIconSourceUrl(source, identity), source)
    const fetch = fakeFetch(() => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'application/octet-stream' }),
      body: bodyOfBytes(ICO_BYTES)
    }))
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, identity)
    assert.ok(opaque?.startsWith(`${EXTENSION_ICON_PROTOCOL}://`))
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    assert.equal(service.readIconContent(id).contentType, 'image/x-icon')
  })

  it('accepts raster bytes with a missing Content-Type', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({}), body: bodyOfBytes(PNG_BYTES) }))
    const service = new ExtensionIconService(fetch)
    const opaque = await service.resolveIcon(source, IDENTITY)
    assert.ok(opaque !== null)
    const id = String(opaque).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    assert.equal(service.readIconContent(id).contentType, 'image/png')
  })

  it('rejects arbitrary hosts even with valid image bytes', async () => {
    const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOfBytes(PNG_BYTES) }))
    const service = new ExtensionIconService(fetch)
    assert.equal(await service.resolveIcon('https://evil.example/icon.png', IDENTITY), null)
    assert.equal(await service.resolveIcon('https://open-vsx.org.evil.example/api/x/file/icon.png', IDENTITY), null)
  })
})

describe('opaque icon mapping (deterministic, no stale fallback)', () => {
  it('maps one source to one stable ID across instances and reloads', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    assert.equal(deterministicIconId(source), deterministicIconId(source))
    assert.ok(/^[0-9a-f]{32}$/.test(deterministicIconId(source)))
    const first = new ExtensionIconService(
      fakeFetch(() => ({ ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOfBytes(PNG_BYTES) }))
    )
    const second = new ExtensionIconService(
      fakeFetch(() => ({ ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOfBytes(PNG_BYTES) }))
    )
    assert.equal(await first.resolveIcon(source, IDENTITY), await second.resolveIcon(source, IDENTITY))
  })

  it('keeps serving a displayed icon after unrelated evictions (LRU touch)', async () => {
    const service = new ExtensionIconService(
      fakeFetch(() => ({ ok: true, status: 200, headers: headers(PNG_HEADERS), body: bodyOfBytes(PNG_BYTES) }))
    )
    const firstSource = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    const first = await service.resolveIcon(firstSource, IDENTITY)
    assert.ok(first !== null)
    const firstId = String(first).slice(`${EXTENSION_ICON_PROTOCOL}://`.length)
    // Display the first icon (protocol read refreshes recency).
    assert.equal(service.readIconContent(firstId).contentType, 'image/png')
    // Flood the cache with unrelated entries (bounded size is 200).
    for (let index = 0; index < 250; index += 1) {
      const identity = { namespace: `ns${index}`, name: 'ext', version: '1.0.0' }
      await service.resolveIcon(`https://openvsx.eclipsecontent.org/ns${index}/ext/1.0.0/icon.png`, identity)
    }
    // A re-resolve of the same source heals to the SAME opaque URL
    // (deterministic mapping): remounts never strand a valid icon.
    const healed = await service.resolveIcon(firstSource, IDENTITY)
    assert.equal(healed, first)
  })

  it('falls back only for genuinely missing icons (404)', async () => {
    const fetch = fakeFetch(() => ({ ok: false, status: 404, headers: headers({}), body: bodyOf('') }))
    const service = new ExtensionIconService(fetch)
    assert.equal(
      await service.resolveIcon('https://open-vsx.org/api/Anthropic/claude-code/2.1.296/file/claude-logo.png', {
        namespace: 'Anthropic',
        name: 'claude-code',
        version: '2.1.296'
      }),
      null
    )
  })
})

describe('icon protocol (opaque IDs only)', () => {  it('parses exactly stark-extension-icon://<32hex> and serves cached bytes', () => {
    const id = 'a'.repeat(32)
    assert.equal(parseExtensionIconUrl(`${EXTENSION_ICON_PROTOCOL}://${id}`), id)
    for (const bad of [
      `${EXTENSION_ICON_PROTOCOL}://${id}/extra`,
      `${EXTENSION_ICON_PROTOCOL}://${id}?x=1`,
      `https://open-vsx.org/api/a/b/1.0.0/file/icon.png`,
      `${EXTENSION_ICON_PROTOCOL}://short`,
      `${EXTENSION_ICON_PROTOCOL}://user@${id}`
    ]) {
      assert.equal(parseExtensionIconUrl(bad), null)
    }
    const ok = serveExtensionIconRequest(`${EXTENSION_ICON_PROTOCOL}://${id}`, () => ({
      bytes: Buffer.from('x'),
      contentType: 'image/png'
    }))
    assert.equal(ok.status, 200)
    assert.equal(serveExtensionIconRequest(`${EXTENSION_ICON_PROTOCOL}://short`, () => ({ bytes: Buffer.from('x'), contentType: 'image/png' })).status, 404)
    assert.equal(
      serveExtensionIconRequest(`${EXTENSION_ICON_PROTOCOL}://${id}`, () => {
        throw new Error('gone')
      }).status,
      404
    )
  })

  it('is icon-specific: no generic remote-image surface in the module', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-icons', 'extension-icon-service.ts'), 'utf8')
    assert.ok(!source.includes('https://${'), 'icon fetch must never template arbitrary hosts')
    assert.ok(!source.includes("'*'"), 'icon origins must never wildcard')
    assert.ok(source.includes('openvsx.eclipsecontent.org'), 'the confirmed asset host must be pinned explicitly')
  })
})
