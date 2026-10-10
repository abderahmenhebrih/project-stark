import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isDeclarativeOnlyManifest, normalizeManifestData } from './extension-manifest'

function manifest(extra: Record<string, unknown>): Parameters<typeof normalizeManifestData>[0] {
  return { name: 'tool', publisher: 'acme', version: '1.0.0', ...extra } as Parameters<typeof normalizeManifestData>[0]
}

const identity = { namespace: 'acme', name: 'tool', version: '1.0.0' }

describe('declarative-only manifests', () => {
  it('recognizes themes/snippets/languages without entrypoints', () => {
    const themes = normalizeManifestData(manifest({ contributes: { themes: [{ id: 't', label: 'T', path: './t.json' }] } }), identity)
    assert.equal(isDeclarativeOnlyManifest(themes), true)
    const snippets = normalizeManifestData(
      manifest({ contributes: { snippets: [{ language: 'ts', path: './s.json' }], grammars: [{ language: 'ts', scopeName: 's', path: './g.json' }] } }),
      identity
    )
    assert.equal(isDeclarativeOnlyManifest(snippets), true)
  })

  it('rejects executable contributions and entrypoint manifests', () => {
    const webview = normalizeManifestData(manifest({ contributes: { webviews: [] } }), identity)
    assert.equal(isDeclarativeOnlyManifest(webview), false)
    const withMain = normalizeManifestData(
      manifest({ main: './out/entry.js', contributes: { themes: [] } }),
      identity
    )
    assert.equal(isDeclarativeOnlyManifest(withMain), false)
    const empty = normalizeManifestData(manifest({}), identity)
    assert.equal(isDeclarativeOnlyManifest(empty), false)
  })
})
