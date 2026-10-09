import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { ExtensionInstallService } from '../extension-install/extension-install-service'
import { createExtensionInstallBindings } from './extension-install'

function openService(): { dir: string; service: ExtensionInstallService } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-install-bind-'))
  return { dir, service: new ExtensionInstallService(dir) }
}

describe('extension install IPC bindings', () => {
  it('exposes exactly install, list-installed, and uninstall', () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionInstallBindings(service)
      assert.deepEqual(
        bindings.map((binding) => binding.channel).sort(),
        ['stark:extensions:install', 'stark:extensions:list-installed', 'stark:extensions:uninstall'].sort()
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates install identity strictly with no path or URL authority', async () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionInstallBindings(service)
      const install = bindings.find((binding) => binding.channel === 'stark:extensions:install')
      assert.ok(install !== undefined)
      for (const bad of [
        null,
        {},
        { namespace: 'a', name: 'b' },
        { namespace: '../evil', name: 'b', version: '1' },
        { namespace: 'a', name: 'b', version: '1', dest: '/tmp/x' },
        { namespace: 'a', name: 'b', version: '1', url: 'https://evil.example/x.vsix' },
        { namespace: 'a', name: 'b', version: '1', path: 'C:\\x' },
        'x',
        42
      ]) {
        await assert.rejects(install.invoke(bad), /not valid|We couldn’t install this extension\./)
      }
      assert.ok(IPC_CHANNELS.extensionsInstall.startsWith('stark:'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists installed entries without leaking paths', async () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionInstallBindings(service)
      const list = bindings.find((binding) => binding.channel === 'stark:extensions:list-installed')
      assert.ok(list !== undefined)
      assert.deepEqual(await list.invoke(undefined), [])
      await assert.rejects(list.invoke({ extra: 1 }), /not valid|We couldn’t install this extension\./)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates uninstall identity strictly with no path authority', async () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionInstallBindings(service)
      const uninstall = bindings.find((binding) => binding.channel === 'stark:extensions:uninstall')
      assert.ok(uninstall !== undefined)
      for (const bad of [
        null,
        {},
        { namespace: 'a', name: 'b' },
        { namespace: '../evil', name: 'b', version: '1' },
        { namespace: 'a', name: 'b', version: '1', path: '/tmp/x' },
        { namespace: 'a', name: 'b', version: '1', directory: 'C:\\x' },
        'x',
        42
      ]) {
        await assert.rejects(uninstall.invoke(bad), /not valid|not safe|We couldn’t install this extension\./)
      }
      await assert.rejects(
        uninstall.invoke({ namespace: 'nobody', name: 'nothing', version: '1.0.0' }),
        /not safe|We couldn’t install this extension\./
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps install failures to public copy without internals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-install-map-'))
    try {
      const service = new ExtensionInstallService(dir, (async () => ({
        ok: false,
        status: 302,
        headers: { get: (name: string) => (name === 'location' ? 'https://evil.example/x.vsix' : null) },
        json: async (): Promise<unknown> => ({}),
        body: null
      })) as never)
      const bindings = createExtensionInstallBindings(service)
      const install = bindings.find((binding) => binding.channel === 'stark:extensions:install')
      assert.ok(install !== undefined)
      await assert.rejects(install.invoke({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('evil.example'))
        assert.ok(!error.message.includes('open-vsx'))
        return true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds no generic download, unzip, or write channels', () => {
    const { dir, service } = openService()
    try {
      const channels = createExtensionInstallBindings(service).map((binding) => binding.channel)
      for (const forbidden of ['generic', 'download', 'unzip', 'write', 'fetch', 'proxy', 'exec', 'shell', 'vsix', 'delete', 'removePath', 'rmdir']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
