import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { ExtensionActivationService } from '../extension-host/extension-activation-service'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import { ExtensionInstallService } from '../extension-install/extension-install-service'
import { ExtensionRuntimeService } from '../extension-host/extension-runtime-service'
import { createExtensionManagementBindings } from './extension-management'

function openRuntime(): { dir: string; runtime: ExtensionRuntimeService } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-mgmt-bind-'))
  const manager = {
    getStatus: () => ({ state: 'stopped' as const }),
    start: async () => ({ state: 'stopped' as const }),
    stop: async () => ({ state: 'stopped' as const }),
    postToHost: () => {
      throw new Error('must not post in binding-shape tests')
    },
    onHostEvent: () => () => {}
  } as unknown as ExtensionHostManager
  const installService = new ExtensionInstallService(dir)
  const activationService = new ExtensionActivationService({ manager, installService, installRoot: dir })
  const runtime = new ExtensionRuntimeService({ manager, activationService, installService, installRoot: dir })
  return { dir, runtime }
}

describe('extension management IPC bindings', () => {
  it('exposes the narrow management channel set (no generic surfaces)', () => {
    const { dir, runtime } = openRuntime()
    try {
      const channels = createExtensionManagementBindings(runtime).map((binding) => binding.channel)
      for (const expected of [
        IPC_CHANNELS.extensionsGetDetails,
        IPC_CHANNELS.extensionsSetTrust,
        IPC_CHANNELS.extensionsAcknowledgeAndActivate,
        IPC_CHANNELS.extensionsFireTrigger,
        IPC_CHANNELS.extensionsListCommands,
        IPC_CHANNELS.extensionsInvokeCommand,
        IPC_CHANNELS.extensionsQueryProviders,
        IPC_CHANNELS.extensionsGetDiagnostics,
        IPC_CHANNELS.extensionsGetOutput,
        IPC_CHANNELS.extensionsListOutputChannels,
        IPC_CHANNELS.extensionsGetStatusItems,
        IPC_CHANNELS.extensionsListNotifications,
        IPC_CHANNELS.extensionsListEditProposals,
        IPC_CHANNELS.extensionsDismissProposal,
        IPC_CHANNELS.extensionsGetConfig,
        IPC_CHANNELS.extensionsUpdateConfig,
        IPC_CHANNELS.extensionsCheckUpdate,
        IPC_CHANNELS.extensionsGetAutoUpdate,
        IPC_CHANNELS.extensionsSetAutoUpdate,
        IPC_CHANNELS.extensionsListPrompts,
        IPC_CHANNELS.extensionsResolvePrompt,
        IPC_CHANNELS.extensionsPushDocumentEvent,
        IPC_CHANNELS.extensionsSetActiveEditor,
        IPC_CHANNELS.extensionsSetWorkspaceFolders,
        IPC_CHANNELS.extensionsListLanguages,
        IPC_CHANNELS.extensionsGetSnippets,
        IPC_CHANNELS.extensionsGetThemeData,
        IPC_CHANNELS.extensionsGetIconTheme,
        IPC_CHANNELS.extensionsGetSelectedThemes,
        IPC_CHANNELS.extensionsSetSelectedTheme
      ]) {
        assert.ok(channels.includes(expected), `management bindings must include ${expected}`)
      }
      for (const forbidden of ['spawn', 'shell', 'terminal', 'vsix', 'child_process', 'write-file']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed payloads with public copy', async () => {
    const { dir, runtime } = openRuntime()
    try {
      const bindings = createExtensionManagementBindings(runtime)
      const byChannel = new Map(bindings.map((binding) => [binding.channel, binding]))
      const trigger = byChannel.get(IPC_CHANNELS.extensionsFireTrigger)
      assert.ok(trigger !== undefined)
      await assert.rejects(trigger.invoke(null), /not valid/)
      await assert.rejects(trigger.invoke({ kind: 'explode' }), /not valid/)
      const execute = byChannel.get(IPC_CHANNELS.extensionsInvokeCommand)
      assert.ok(execute !== undefined)
      await assert.rejects(execute.invoke({ command: '' }), /not valid/)
      const trust = byChannel.get(IPC_CHANNELS.extensionsSetTrust)
      assert.ok(trust !== undefined)
      await assert.rejects(trust.invoke({ namespace: 'a', name: 'b', version: '1.0.0' }), /not valid/)
      const prompt = byChannel.get(IPC_CHANNELS.extensionsResolvePrompt)
      assert.ok(prompt !== undefined)
      await assert.rejects(prompt.invoke({}), /not valid/)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves empty caches without a host', async () => {
    const { dir, runtime } = openRuntime()
    try {
      const bindings = createExtensionManagementBindings(runtime)
      const byChannel = new Map(bindings.map((binding) => [binding.channel, binding]))
      assert.deepEqual(await byChannel.get(IPC_CHANNELS.extensionsListNotifications)?.invoke(undefined), [])
      assert.deepEqual(await byChannel.get(IPC_CHANNELS.extensionsListEditProposals)?.invoke(undefined), [])
      assert.deepEqual(await byChannel.get(IPC_CHANNELS.extensionsGetAutoUpdate)?.invoke(undefined), false)
      assert.deepEqual(await byChannel.get(IPC_CHANNELS.extensionsListPrompts)?.invoke(undefined), [])
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
