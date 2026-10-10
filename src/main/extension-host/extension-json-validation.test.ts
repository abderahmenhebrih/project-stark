import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  fetchRemoteJsonSchema,
  isBlockedSchemaAddress,
  isLocalSchemaUrl,
  readLocalJsonSchema,
  resolveLocalSchemaPath,
  toMonacoFilePatterns,
  validatedRemoteSchemaUrl,
  type SchemaFetch
} from './extension-json-validation'

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    lower[key.toLowerCase()] = value
  }
  return { get: (name: string) => lower[name.toLowerCase()] ?? null }
}

function jsonBody(value: string): unknown {
  const buffer = Buffer.from(value, 'utf8')
  async function* chunks(): AsyncGenerator<Buffer> {
    yield buffer
  }
  return chunks()
}

describe('jsonValidation URL classes', () => {
  it('separates extension-local refs from remote refs', () => {
    assert.equal(isLocalSchemaUrl('./package-json-schema.json'), true)
    assert.equal(isLocalSchemaUrl('schemas/draft.json'), true)
    assert.equal(isLocalSchemaUrl('https://json.schemastore.org/prettierrc'), false)
    assert.equal(isLocalSchemaUrl('http://example.com/s.json'), false)
    assert.equal(isLocalSchemaUrl('/absolute/s.json'), false)
    assert.equal(isLocalSchemaUrl('C:\\win\\s.json'), false)
    assert.equal(isLocalSchemaUrl('//protocol/relative.json'), false)
  })

  it('validates remote URLs as HTTPS-only without credentials or ports', () => {
    assert.equal(validatedRemoteSchemaUrl('https://json.schemastore.org/prettierrc'), 'https://json.schemastore.org/prettierrc')
    for (const bad of [
      'http://json.schemastore.org/prettierrc',
      'https://user:pass@example.com/s.json',
      'https://example.com:8443/s.json',
      'data:application/json,{}',
      'file:///etc/passwd',
      '',
      '../relative.json'
    ]) {
      assert.equal(validatedRemoteSchemaUrl(bad), null)
    }
  })
})

describe('local schema containment', () => {
  it('reads schemas only inside the owning extension directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-json-schema-'))
    try {
      const extensionDir = join(root, 'extension')
      mkdirSync(extensionDir, { recursive: true })
      writeFileSync(join(extensionDir, 'package-json-schema.json'), JSON.stringify({ type: 'object' }))
      assert.deepEqual(readLocalJsonSchema(extensionDir, './package-json-schema.json'), { type: 'object' })
      assert.equal(resolveLocalSchemaPath(extensionDir, '../escape.json'), null)
      assert.equal(readLocalJsonSchema(extensionDir, '../escape.json'), null)
      assert.equal(readLocalJsonSchema(extensionDir, '/absolute.json'), null)
      assert.equal(readLocalJsonSchema(extensionDir, 'https://example.com/s.json'), null)
      assert.equal(readLocalJsonSchema(extensionDir, './missing.json'), null)
      writeFileSync(join(extensionDir, 'array.json'), '[]')
      assert.equal(readLocalJsonSchema(extensionDir, './array.json'), null)
      writeFileSync(join(extensionDir, 'broken.json'), '{nope')
      assert.equal(readLocalJsonSchema(extensionDir, './broken.json'), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses symlinked schema files', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-json-schema-link-'))
    try {
      const extensionDir = join(root, 'extension')
      mkdirSync(extensionDir, { recursive: true })
      writeFileSync(join(root, 'outside.json'), JSON.stringify({ type: 'object' }))
      try {
        symlinkSync(join(root, 'outside.json'), join(extensionDir, 'link.json'))
      } catch {
        return
      }
      assert.equal(readLocalJsonSchema(extensionDir, './link.json'), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('remote schema fetch bounds', () => {
  // Unit tests never touch DNS: the host check is injected.
  const publicHost = async (): Promise<void> => {}
  const blockedHost = async (): Promise<void> => {
    throw new Error('Schema host is not reachable.')
  }

  it('fetches one bounded HTTPS schema with zero retries', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, headers: headers({ 'content-type': 'application/schema+json' }), body: jsonBody('{"type":"object"}') }
    }) as unknown as SchemaFetch
    const schema = await fetchRemoteJsonSchema('https://json.schemastore.org/prettierrc', fetchImpl, publicHost)
    assert.deepEqual(schema, { type: 'object' })
    assert.equal(calls.length, 1)
  })

  it('refuses non-HTTPS, failures, oversize, and non-JSON without throwing', async () => {
    const okFetch = (async () => ({
      ok: true,
      status: 200,
      headers: headers({}),
      body: jsonBody('{"type":"object"}')
    })) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('http://example.com/s.json', okFetch, publicHost), null)
    const failFetch = (async () => ({ ok: false, status: 404, headers: headers({}), body: jsonBody('') })) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', failFetch, publicHost), null)
    const bigFetch = (async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-length': String(1024 * 1024) }),
      body: jsonBody('{}')
    })) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', bigFetch, publicHost), null)
    const htmlFetch = (async () => ({
      ok: true,
      status: 200,
      headers: headers({}),
      body: jsonBody('<html/>')
    })) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', htmlFetch, publicHost), null)
    const downFetch = (async () => {
      throw new Error('down')
    }) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', downFetch, publicHost), null)
  })

  it('refuses blocked (private) hosts before fetching', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return { ok: true, status: 200, headers: headers({}), body: jsonBody('{}') }
    }) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', fetchImpl, blockedHost), null)
    assert.equal(called, false)
  })

  it('validates every redirect hop and refuses escapes', async () => {
    const evilFetch = (async () => ({
      ok: false,
      status: 302,
      headers: headers({ location: 'https://evil.example/s.json' }),
      body: jsonBody('')
    })) as unknown as SchemaFetch
    // The hop host check refuses before any second request.
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', evilFetch, blockedHost), null)
    // An endless HTTPS redirect chain exhausts the hop bound (4
    // attempts: initial + 3 hops) and resolves to null, never loops.
    let loopCalls = 0
    const loopFetch = (async () => {
      loopCalls += 1
      return { ok: false, status: 302, headers: headers({ location: 'https://example.com/loop.json' }), body: jsonBody('') }
    }) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', loopFetch, publicHost), null)
    assert.equal(loopCalls, 4)
    const httpHop = (async () => ({
      ok: false,
      status: 301,
      headers: headers({ location: 'http://example.com/s.json' }),
      body: jsonBody('')
    })) as unknown as SchemaFetch
    assert.equal(await fetchRemoteJsonSchema('https://example.com/s.json', httpHop, publicHost), null)
  })
})

describe('Monaco fileMatch expansion', () => {
  it('keeps globs untouched and expands bare filenames deterministically', () => {
    assert.deepEqual(toMonacoFilePatterns(['.prettierrc']), ['.prettierrc', '**/.prettierrc'])
    assert.deepEqual(toMonacoFilePatterns(['package.json']), ['package.json', '**/package.json'])
    assert.deepEqual(toMonacoFilePatterns(['*.json', '**/*.json']), ['*.json', '**/*.json'])
    assert.deepEqual(toMonacoFilePatterns([]), [])
  })
})

describe('SSRF address guard', () => {
  it('refuses loopback, private, link-local, and reserved addresses', () => {
    for (const blocked of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.10.20',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd00::1',
      'ff02::1'
    ]) {
      assert.equal(isBlockedSchemaAddress(blocked), true, blocked)
    }
    for (const open of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '100.128.0.1', '2001:4860:4860::8888']) {
      assert.equal(isBlockedSchemaAddress(open), false, open)
    }
  })
})
