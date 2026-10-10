import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { ExtensionActivationService } from '../extension-host/extension-activation-service'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import { createExtensionActivationBindings } from './extension-activation'

function openService(): { dir: string; service: ExtensionActivationService } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-activate-bind-'))
  const listeners: ((event: { kind: string; raw?: unknown }) => void)[] = []
  const manager = {
    getStatus: () => ({ state: 'stopped' as const }),
    start: async () => ({ state: 'stopped' as const }),
    stop: async () => ({ state: 'stopped' as const }),
    postToHost: () => {
      throw new Error('must not post in binding-shape tests')
    },
    onHostEvent: (listener: (event: { kind: string; raw?: unknown }) => void) => {
      listeners.push(listener)
      return () => {}
    }
  } as unknown as ExtensionHostManager
  const service = new ExtensionActivationService({
    manager,
    installService: { listInstalled: async () => [] },
    installRoot: dir
  })
  return { dir, service }
}

describe('generic activation IPC bindings', () => {
  it('exposes exactly activate, deactivate, and list-active', () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionActivationBindings(service)
      assert.deepEqual(
        bindings.map((b) => b.channel).sort(),
        [IPC_CHANNELS.extensionsActivate, IPC_CHANNELS.extensionsDeactivate, IPC_CHANNELS.extensionsListActive].sort()
      )
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects renderer-supplied paths and malformed identities with public copy', async () => {
    const { dir, service } = openService()
    try {
      const bindings = createExtensionActivationBindings(service)
      const activate = bindings.find((b) => b.channel === IPC_CHANNELS.extensionsActivate)
      assert.ok(activate !== undefined)
      for (const bad of [
        undefined,
        null,
        {},
        { namespace: 'a', name: 'b' },
        { namespace: 'a', name: 'b', version: '1.0.0', path: '/tmp/x' },
        { namespace: 'a', name: 'b', version: '1.0.0', extensionDir: '/tmp/x' },
        { namespace: 'a', name: 'b', version: '1.0.0', storeRoot: '/tmp' },
        { namespace: '../evil', name: 'x', version: '1.0.0' }
      ]) {
        await assert.rejects(activate.invoke(bad), /not valid|could not be activated/)
      }
      const listActive = bindings.find((b) => b.channel === IPC_CHANNELS.extensionsListActive)
      assert.ok(listActive !== undefined)
      await assert.rejects(listActive.invoke({ extra: 1 }), /not valid|could not be activated/)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds no generic spawn, send, exec, or write channels', () => {
    const { dir, service } = openService()
    try {
      const channels = createExtensionActivationBindings(service).map((b) => b.channel)
      for (const forbidden of ['spawn', 'exec', 'shell', 'write', 'vsix', 'command']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
