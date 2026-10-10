import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapJsonSchemasForMonaco } from './json-schema-mapping'

describe('Monaco JSON-schema mapping (pure)', () => {
  it('maps Prettier-shaped entries with owner-scoped URIs', () => {
    const mapped = mapJsonSchemasForMonaco([
      {
        owner: 'esbenp.prettier-vscode@12.4.0',
        fileMatch: ['package.json', '**/package.json'],
        url: './package-json-schema.json',
        schema: { type: 'object' }
      }
    ])
    assert.equal(mapped.length, 1)
    assert.ok(mapped[0]?.uri.startsWith('stark-extension-schema://esbenp.prettier-vscode@12.4.0/'))
    assert.deepEqual(mapped[0]?.fileMatch, ['package.json', '**/package.json'])
    assert.deepEqual(mapped[0]?.schema, { type: 'object' })
    assert.ok(!(mapped[0] as { url?: unknown }).url, 'no remote URL may reach Monaco (no renderer fetching)')
  })

  it('skips malformed, owner-less, and oversized entries deterministically', () => {
    const big: Record<string, unknown> = { data: 'x'.repeat(300 * 1024) }
    const mapped = mapJsonSchemasForMonaco([
      null,
      'nope',
      [],
      { owner: '', fileMatch: ['a.json'], url: 'u', schema: { type: 'object' } },
      { owner: 'a.b@1', fileMatch: [], url: 'u', schema: { type: 'object' } },
      { owner: 'a.b@1', fileMatch: ['a.json'], url: 'u', schema: null },
      { owner: 'a.b@1', fileMatch: ['a.json'], url: 'u', schema: big },
      { owner: 'a.b@1', fileMatch: ['a.json'], url: 'u', schema: { type: 'object' } }
    ])
    assert.equal(mapped.length, 1)
    assert.ok(mapped[0]?.uri.startsWith('stark-extension-schema://a.b@1/'))
  })

  it('bounds counts deterministically', () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      owner: `a.b@${index}`,
      fileMatch: ['x.json'],
      url: 'u',
      schema: { type: 'object' }
    }))
    const mapped = mapJsonSchemasForMonaco(entries)
    assert.equal(mapped.length, 64)
    assert.deepEqual(
      mapped.map((entry) => entry.uri),
      [...new Set(mapped.map((entry) => entry.uri))]
    )
  })
})
