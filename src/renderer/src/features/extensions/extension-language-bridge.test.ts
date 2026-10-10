import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapCompletionItems, mapHoverContents, mapLocations, queryWithSingleFlight, resolveTreeFileIcon, toMonacoCompletionKind, toMonacoSeverity } from './extension-language-bridge'

describe('extension language bridge mappers', () => {
  it('maps completion kinds and caps items', () => {
    assert.equal(toMonacoCompletionKind(1), 0)
    assert.equal(toMonacoCompletionKind(13), 17)
    assert.equal(toMonacoCompletionKind(999), 18)
    const mapped = mapCompletionItems({ items: [{ label: 'a', kind: 1, detail: 'd' }, { label: '', kind: 0 }, null] })
    assert.equal(mapped.length, 1)
    assert.equal(mapped[0]?.label, 'a')
  })

  it('maps hover and locations with bounds', () => {
    assert.equal(mapHoverContents({ contents: 'hi' }), 'hi')
    assert.equal(mapHoverContents(null), '')
    const locations = mapLocations({ locations: [{ uri: 'file:a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }, { nope: true }] })
    assert.equal(locations.length, 1)
  })

  it('maps severities to Monaco markers', () => {
    assert.equal(toMonacoSeverity(0), 8)
    assert.equal(toMonacoSeverity(1), 4)
    assert.equal(toMonacoSeverity(2), 2)
    assert.equal(toMonacoSeverity(3), 1)
  })

  it('single-flights identical queries', async () => {
    let calls = 0
    const run = (): Promise<Record<string, unknown> | null> => {
      calls += 1
      return Promise.resolve({ ok: true })
    }
    const [first, second] = await Promise.all([queryWithSingleFlight('k', run), queryWithSingleFlight('k', run)])
    assert.deepEqual(first, { ok: true })
    assert.deepEqual(second, { ok: true })
    assert.equal(calls, 1)
  })

  it('resolves tree file icons from icon themes without branding', () => {
    const theme = { fileExtensions: { ts: 'ts-icon' }, fileNames: { 'package.json': 'npm-icon' }, icons: { 'ts-icon': 'data:image/svg+xml;base64,AAA', 'npm-icon': 'data:image/svg+xml;base64,BBB' } }
    assert.equal(resolveTreeFileIcon('package.json', theme), 'data:image/svg+xml;base64,BBB')
    assert.equal(resolveTreeFileIcon('src/a.ts', theme), 'data:image/svg+xml;base64,AAA')
    assert.equal(resolveTreeFileIcon('README.md', theme), null)
    assert.equal(resolveTreeFileIcon('a.ts', null), null)
  })
})
