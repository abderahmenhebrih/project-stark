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
      throw new Error('must not post in NLS tests')
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

describe('command title NLS resolution (generic package.nls.json)', () => {
  it('resolves Prettier-style %key% titles for the palette', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-nls-'))
    const runtime = openRuntime(dir)
    try {
      craftInstalled(
        dir,
        'esbenp',
        'prettier-vscode',
        '12.4.0',
        {
          commands: [
            { command: 'prettier.createConfigFile', title: '%ext.command.createConfigFile.title%' },
            { command: 'prettier.openOutput', title: 'Open Output' }
          ]
        },
        {
          'package.nls.json': JSON.stringify({
            'ext.command.createConfigFile.title': 'Create Prettier Configuration File'
          })
        }
      )
      const commands = await runtime.listCommands()
      const created = commands.find((entry) => entry.command === 'prettier.createConfigFile')
      assert.equal(created?.title, 'Create Prettier Configuration File')
      const output = commands.find((entry) => entry.command === 'prettier.openOutput')
      assert.equal(output?.title, 'Open Output')
      for (const entry of commands) {
        assert.ok(!entry.title.includes('%ext.'), 'no raw NLS placeholder may reach the palette')
      }
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the inner key without a table, and stays contained', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-nls-fallback-'))
    const runtime = openRuntime(dir)
    try {
      craftInstalled(dir, 'acme', 'ext', '1.0.0', {
        commands: [{ command: 'acme.do', title: '%missing.key%' }]
      })
      const commands = await runtime.listCommands()
      assert.equal(commands.find((entry) => entry.command === 'acme.do')?.title, 'missing.key')
      const details = await runtime.getDetails({ namespace: 'acme', name: 'ext', version: '1.0.0' })
      assert.equal(details.commands.find((entry) => entry.command === 'acme.do')?.title, 'missing.key')
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
