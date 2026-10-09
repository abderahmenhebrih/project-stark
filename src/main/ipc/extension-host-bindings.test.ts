import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { ExtensionHostManager } from '../extension-host/extension-host-manager'
import { createExtensionHostBindings } from './extension-host'

function openManager(): { dir: string; manager: ExtensionHostManager } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-host-bind-'))
  return {
    dir,
    manager: new ExtensionHostManager({
      bootstrapPath: join(dir, 'extension-host-bootstrap.js'),
      userDataDir: dir,
      launcher: {
        fork: () => {
          throw new Error('spawn must not run in binding tests')
        }
      }
    })
  }
}

describe('extension host IPC bindings', () => {
  it('exposes exactly host-status, host-start, and host-stop', () => {
    const { dir, manager } = openManager()
    try {
      const bindings = createExtensionHostBindings(manager)
      assert.deepEqual(
        bindings.map((binding) => binding.channel).sort(),
        ['stark:extensions:host-status', 'stark:extensions:host-start', 'stark:extensions:host-stop'].sort()
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('status reads without spawning', async () => {
    const { dir, manager } = openManager()
    try {
      const bindings = createExtensionHostBindings(manager)
      const status = bindings.find((binding) => binding.channel === 'stark:extensions:host-status')
      assert.ok(status !== undefined)
      assert.deepEqual(await status.invoke(undefined), { state: 'stopped' })
      assert.deepEqual(await status.invoke({}), { state: 'stopped' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-empty payloads with public copy', async () => {
    const { dir, manager } = openManager()
    try {
      const bindings = createExtensionHostBindings(manager)
      for (const channel of ['stark:extensions:host-status', 'stark:extensions:host-start', 'stark:extensions:host-stop']) {
        const binding = bindings.find((entry) => entry.channel === channel)
        assert.ok(binding !== undefined)
        await assert.rejects(binding.invoke({ command: 'x' }), /not valid|unavailable/)
      }
      assert.ok(IPC_CHANNELS.extensionsHostStart.startsWith('stark:'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds no generic spawn, send, or exec channels', () => {
    const { dir, manager } = openManager()
    try {
      const channels = createExtensionHostBindings(manager).map((binding) => binding.channel)
      for (const forbidden of ['generic', 'spawn', 'send', 'exec', 'shell', 'message', 'command', 'vsix']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
