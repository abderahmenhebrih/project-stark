import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_ICON_CDN_HOST,
  EXTENSION_ICON_MAX_BYTES,
  EXTENSION_ICON_TIMEOUT_MS,
  ExtensionIconService,
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
    // SVG rejected (no reviewed safe SVG policy).
    assert.equal(
      (await resolves(() => ({ ok: true, status: 200, headers: headers({ 'content-type': 'image/svg+xml' }), body: bodyOf('<svg/>') }))).opaque,
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

  it('accepts only image/png, image/jpeg, image/webp, image/gif', async () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/png; charset=binary']) {
      const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({ 'content-type': contentType }), body: bodyOf('x') }))
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

  it('sniffs octet-stream bodies: raster accepted, junk and SVG rejected', async () => {
    const source = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png'
    async function resolvesOctetStream(body: unknown): Promise<string | null> {
      const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: headers({ 'content-type': 'application/octet-stream' }), body }))
      return new ExtensionIconService(fetch).resolveIcon(source, IDENTITY)
    }
    const png = await resolvesOctetStream(bodyOfBytes(PNG_BYTES))
    assert.ok(png !== null, 'octet-stream over real PNG bytes must render')
    assert.equal(await resolvesOctetStream(bodyOf('not-an-image')), null)
    assert.equal(await resolvesOctetStream(bodyOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
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

describe('icon protocol (opaque IDs only)', () => {
  it('parses exactly stark-extension-icon://<32hex> and serves cached bytes', () => {
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
