import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { FormatterService } from '../formatter/formatter-service'
import { createFormatterBindings } from './formatter'

function openService(): { service: FormatterService; posted: unknown[] } {
  const posted: unknown[] = []
  const manager = {
    getStatus: () => ({ state: 'stopped' as const }),
    start: async () => ({ state: 'stopped' as const }),
    stop: async () => ({ state: 'stopped' as const }),
    postToHost: (message: unknown) => {
      posted.push(message)
    },
    onHostEvent: () => () => {}
  } as unknown as ExtensionHostManager
  const service = new FormatterService({
    manager,
    installService: {} as ExtensionInstallService,
    filesService: {} as WorkspaceFilesService,
    workspaces: {} as WorkspaceRepository,
    formatterModuleUrl: 'file:///stark-test/formatter-host.mjs'
  })
  return { service, posted }
}

describe('formatter IPC bindings', () => {
  it('exposes exactly the format-document channel', () => {
    const { service } = openService()
    try {
      const bindings = createFormatterBindings(service)
      assert.deepEqual(
        bindings.map((binding) => binding.channel),
        ['stark:formatter:format-document']
      )
      assert.equal(IPC_CHANNELS.formatterFormatDocument, 'stark:formatter:format-document')
    } finally {
      service.dispose()
    }
  })

  it('validates the request strictly with no text or path authority', async () => {
    const { service } = openService()
    try {
      const bindings = createFormatterBindings(service)
      const format = bindings.find((binding) => binding.channel === 'stark:formatter:format-document')
      assert.ok(format !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 7 },
        { relativePath: 'a.js' },
        { workspaceId: 0, relativePath: 'a.js' },
        { workspaceId: -3, relativePath: 'a.js' },
        { workspaceId: 1.5, relativePath: 'a.js' },
        { workspaceId: '7', relativePath: 'a.js' },
        { workspaceId: 7, relativePath: '' },
        { workspaceId: 7, relativePath: 'a.js', text: 'evil' },
        { workspaceId: 7, relativePath: 'a.js', absolutePath: '/tmp/x.js' },
        { workspaceId: 7, relativePath: 'a.js', extensionDir: '/tmp/x' },
        'x',
        42
      ]) {
        await assert.rejects(format.invoke(bad), /not valid|No changes were made/)
      }
    } finally {
      service.dispose()
    }
  })

  it('maps service failures to public copy without internals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-fmt-bind-'))
    try {
      const { service } = openService()
      try {
        const bindings = createFormatterBindings(service)
        const format = bindings.find((binding) => binding.channel === 'stark:formatter:format-document')
        assert.ok(format !== undefined)
        await assert.rejects(format.invoke({ workspaceId: 7, relativePath: 'a.py' }), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'No formatter is available for this file.')
          assert.ok(!error.message.includes(dir))
          return true
        })
      } finally {
        service.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds no generic execution surface', () => {
    const { service } = openService()
    try {
      const channels = createFormatterBindings(service).map((binding) => binding.channel)
      for (const forbidden of ['execute', 'run', 'spawn', 'eval', 'activate', 'command', 'generic', 'rpc']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      service.dispose()
    }
  })
})
