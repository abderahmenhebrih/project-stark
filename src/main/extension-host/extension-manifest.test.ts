import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ExtensionActivationError } from './extension-activation-errors'
import {
  normalizeManifestData,
  readNormalizedManifest,
  requireSupportedExtensionKind
} from './extension-manifest'

const IDENTITY = { namespace: 'fixture', name: 'extension-a', version: '1.0.0' }

function craftVersionDir(root: string, manifest: Record<string, unknown>): string {
  const versionDir = join(root, 'fixture.extension-a', '1.0.0')
  mkdirSync(join(versionDir, 'extension'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify(manifest))
  return versionDir
}

describe('generic manifest normalization', () => {
  it('normalizes only bounded fields and proves identity', () => {
    const normalized = normalizeManifestData(
      {
        name: 'extension-a',
        publisher: 'fixture',
        version: '1.0.0',
        displayName: 'Fixture A',
        main: './out/extension.js',
        activationEvents: ['onLanguage:javascript'],
        engines: { vscode: '^1.80.0' },
        extensionKind: ['workspace'],
        categories: ['Formatters'],
        contributes: { languages: [{ id: 'javascript' }] },
        scripts: { postinstall: 'evil()' }
      },
      IDENTITY
    )
    assert.equal(normalized.name, 'extension-a')
    assert.equal(normalized.publisher, 'fixture')
    assert.equal(normalized.displayName, 'Fixture A')
    assert.equal(normalized.main, './out/extension.js')
    assert.deepEqual([...normalized.activationEvents], ['onLanguage:javascript'])
    assert.equal(normalized.enginesVscode, '^1.80.0')
    assert.deepEqual([...normalized.extensionKind], ['workspace'])
    assert.deepEqual([...normalized.categories], ['Formatters'])
    // Contributes survives bounded; scripts never survive (never executed).
    assert.ok(normalized.contributes !== null)
    assert.ok(!('scripts' in (normalized as unknown as Record<string, unknown>)))
  })

  it('rejects identity mismatch', () => {
    assert.throws(
      () => normalizeManifestData({ name: 'other', publisher: 'fixture', version: '1.0.0' }, IDENTITY),
      (error: unknown) => error instanceof ExtensionActivationError && error.code === 'manifest-mismatch'
    )
    assert.throws(
      () => normalizeManifestData({ name: 'extension-a', publisher: 'evil', version: '1.0.0' }, IDENTITY),
      (error: unknown) => error instanceof ExtensionActivationError && error.code === 'manifest-mismatch'
    )
  })

  it('rejects malformed manifests without detail', () => {
    for (const bad of [null, [], 'x', {}, { name: 'extension-a' }]) {
      assert.throws(() => normalizeManifestData(bad, IDENTITY), ExtensionActivationError)
    }
  })

  it('bounds activationEvents but records "*" without acting (no auto-activation)', () => {
    const normalized = normalizeManifestData(
      { name: 'extension-a', publisher: 'fixture', version: '1.0.0', main: './entry.js', activationEvents: ['*'] },
      IDENTITY
    )
    assert.deepEqual([...normalized.activationEvents], ['*'])
    // Recording is data only: activation stays demand-driven (proven in
    // the service suite — no startup sweep consumes this field).
  })

  it('supports Node main, rejects browser-only honestly', () => {
    const node = normalizeManifestData(
      { name: 'extension-a', publisher: 'fixture', version: '1.0.0', main: './entry.js' },
      IDENTITY
    )
    requireSupportedExtensionKind(node)
    const browserOnly = normalizeManifestData(
      { name: 'extension-a', publisher: 'fixture', version: '1.0.0', browser: './out/web.js' },
      IDENTITY
    )
    assert.throws(
      () => requireSupportedExtensionKind(browserOnly),
      (error: unknown) => error instanceof ExtensionActivationError && error.code === 'unsupported-extension-kind'
    )
    const neither = normalizeManifestData({ name: 'extension-a', publisher: 'fixture', version: '1.0.0' }, IDENTITY)
    assert.throws(() => requireSupportedExtensionKind(neither), ExtensionActivationError)
  })

  it('reads package.json as data only from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-manifest-'))
    try {
      const versionDir = craftVersionDir(root, {
        name: 'extension-a',
        publisher: 'fixture',
        version: '1.0.0',
        displayName: 'A',
        main: './entry.js'
      })
      const normalized = readNormalizedManifest(versionDir, IDENTITY)
      assert.equal(normalized.main, './entry.js')
      assert.throws(() => readNormalizedManifest(join(root, 'missing'), IDENTITY), ExtensionActivationError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never sends raw package.json (bounded subset only)', () => {
    const source = normalizeManifestData(
      {
        name: 'extension-a',
        publisher: 'fixture',
        version: '1.0.0',
        main: './entry.js',
        secretField: 'must-not-survive',
        downloadUrl: 'https://evil.example/x.vsix'
      },
      IDENTITY
    )
    const keys = Object.keys(source).sort()
    assert.deepEqual(keys, ['activationEvents', 'browser', 'categories', 'contributes', 'displayName', 'enginesVscode', 'extensionKind', 'main', 'name', 'publisher', 'version'])
  })
})
