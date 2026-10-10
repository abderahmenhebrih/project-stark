import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ExtensionActivationService } from './extension-activation-service'
import type { ExtensionHostManager } from './extension-host-manager'
import { ExtensionInstallService } from '../extension-install/extension-install-service'
import { ExtensionRuntimeService } from './extension-runtime-service'

function openRuntime(dir: string): ExtensionRuntimeService {
  const manager = {
    getStatus: () => ({ state: 'stopped' as const }),
    start: async () => ({ state: 'stopped' as const }),
    stop: async () => ({ state: 'stopped' as const }),
    postToHost: () => {
      throw new Error('must not post in schema tests')
    },
    onHostEvent: () => () => {}
  } as unknown as ExtensionHostManager
  const installService = new ExtensionInstallService(dir)
  const activationService = new ExtensionActivationService({ manager, installService, installRoot: dir })
  return new ExtensionRuntimeService({ manager, activationService, installService, installRoot: dir })
}

function craftInstalled(
  root: string,
  namespace: string,
  name: string,
  version: string,
  contributes: Record<string, unknown>,
  extraFiles: Record<string, string> = {}
): void {
  const versionDir = join(root, `${namespace}.${name}`, version)
  const extensionDir = join(versionDir, 'extension')
  mkdirSync(extensionDir, { recursive: true })
  writeFileSync(
    join(versionDir, 'stark-install.json'),
    JSON.stringify({ namespace, name, version, source: 'open-vsx', displayName: name })
  )
  writeFileSync(
    join(extensionDir, 'package.json'),
    JSON.stringify({ name, publisher: namespace, version, displayName: name, contributes })
  )
  for (const [relPath, content] of Object.entries(extraFiles)) {
    writeFileSync(join(extensionDir, relPath), content)
  }
}

describe('runtime jsonValidation schemas (generic contribution)', () => {
  it('resolves Prettier-shaped local schemas with owner identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-json-rt-'))
    const runtime = openRuntime(dir)
    try {
      craftInstalled(
        dir,
        'esbenp',
        'prettier-vscode',
        '12.4.0',
        {
          configuration: {},
          languages: [],
          commands: [],
          jsonValidation: [
            { fileMatch: '.prettierrc', url: 'https://json.schemastore.org/prettierrc' },
            { fileMatch: ['.prettierrc.json', 'package.json'], url: './package-json-schema.json' }
          ]
        },
        { 'package-json-schema.json': JSON.stringify({ type: 'object', properties: { printWidth: { type: 'number' } } }) }
      )
      const schemas = await runtime.listJsonSchemas()
      const local = schemas.filter((entry) => entry.owner === 'esbenp.prettier-vscode@12.4.0' && entry.url === './package-json-schema.json')
      assert.equal(local.length, 1)
      assert.deepEqual(local[0]?.fileMatch, ['.prettierrc.json', '**/.prettierrc.json', 'package.json', '**/package.json'])
      assert.deepEqual(local[0]?.schema, { type: 'object', properties: { printWidth: { type: 'number' } } })
      // Every returned entry carries an inline schema (never a
      // renderer-fetchable URL): remote entries are included only
      // when the bounded main-owned fetch actually resolved them.
      for (const entry of schemas) {
        assert.ok(entry.schema !== null && typeof entry.schema === 'object' && !Array.isArray(entry.schema))
        assert.ok(entry.fileMatch.length > 0)
      }
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops schemas on disable and restores on enable (structural unregister)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-json-rt-toggle-'))
    const runtime = openRuntime(dir)
    try {
      craftInstalled(
        dir,
        'acme',
        'schemas',
        '1.0.0',
        { jsonValidation: [{ fileMatch: 'data.json', url: './schema.json' }] },
        { 'schema.json': JSON.stringify({ type: 'object' }) }
      )
      assert.equal((await runtime.listJsonSchemas()).filter((entry) => entry.owner === 'acme.schemas@1.0.0').length, 1)
      const installService = new ExtensionInstallService(dir)
      await installService.setEnabled({ namespace: 'acme', name: 'schemas', version: '1.0.0' }, false)
      assert.deepEqual(
        (await runtime.listJsonSchemas()).filter((entry) => entry.owner === 'acme.schemas@1.0.0'),
        []
      )
      await installService.setEnabled({ namespace: 'acme', name: 'schemas', version: '1.0.0' }, true)
      assert.equal((await runtime.listJsonSchemas()).filter((entry) => entry.owner === 'acme.schemas@1.0.0').length, 1)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips traversal and missing local schemas without failing the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-json-rt-evil-'))
    const runtime = openRuntime(dir)
    try {
      craftInstalled(dir, 'evil', 'ext', '1.0.0', {
        jsonValidation: [
          { fileMatch: 'x.json', url: '../escape.json' },
          { fileMatch: 'y.json', url: './missing.json' },
          { fileMatch: 'z.json', url: './schema.json' }
        ]
      }, { 'schema.json': JSON.stringify({ type: 'object' }) })
      const schemas = await runtime.listJsonSchemas()
      const owned = schemas.filter((entry) => entry.owner === 'evil.ext@1.0.0')
      assert.equal(owned.length, 1)
      assert.equal(owned[0]?.url, './schema.json')
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
