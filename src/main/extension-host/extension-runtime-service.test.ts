import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EXTENSION_HOST_PROTOCOL } from './protocol'
import { ExtensionActivationService } from './extension-activation-service'
import type { ExtensionHostManager } from './extension-host-manager'
import { ExtensionInstallService } from '../extension-install/extension-install-service'
import { ExtensionRuntimeService } from './extension-runtime-service'
import { writeExtensionTrust } from './extension-trust'

function openHarness(): {
  dir: string
  posted: unknown[]
  listeners: ((event: { kind: string; raw?: unknown }) => void)[]
  service: ExtensionRuntimeService
} {
  const dir = mkdtempSync(join(tmpdir(), 'stark-runtime-'))
  const posted: unknown[] = []
  const listeners: ((event: { kind: string; raw?: unknown }) => void)[] = []
  const manager = {
    getStatus: () => ({ state: 'ready' as const }),
    start: async () => ({ state: 'ready' as const }),
    stop: async () => ({ state: 'ready' as const }),
    postToHost: (message: unknown) => {
      posted.push(message)
    },
    onHostEvent: (listener: (event: { kind: string; raw?: unknown }) => void) => {
      listeners.push(listener)
      return () => {}
    }
  } as unknown as ExtensionHostManager
  const installService = new ExtensionInstallService(dir)
  const activationService = new ExtensionActivationService({ manager, installService, installRoot: dir })
  const service = new ExtensionRuntimeService({
    manager,
    activationService,
    installService,
    installRoot: dir,
    workspaceFiles: {
      listFiles: (pattern: string) => (pattern === '*.json' ? ['file:/root/package.json'] : []),
      readFile: (relativePath: string) => (relativePath === 'package.json' ? { text: '{}', languageId: 'json' } : null),
      statFile: (relativePath: string) => (relativePath === 'package.json' ? { type: 1 } : null)
    },
    workspaceRootProvider: () => '/root',
    promptTimeoutMs: 100,
    providerTimeoutMs: 100,
    commandTimeoutMs: 100
  })
  return { dir, posted, listeners, service }
}

function emit(listeners: ((event: { kind: string; raw?: unknown }) => void)[], type: string, payload: Record<string, unknown>): void {
  for (const listener of listeners) {
    listener({ kind: 'message', raw: { protocol: EXTENSION_HOST_PROTOCOL, type, payload } })
  }
}

function craftInstalled(dir: string, namespace: string, name: string, version: string, manifest: Record<string, unknown>): void {
  const versionDir = join(dir, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension', 'out'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version, ...manifest }))
  writeFileSync(join(versionDir, 'extension', 'out', 'entry.js'), 'export async function activate() {}\n')
  writeFileSync(
    join(versionDir, 'stark-install.json'),
    JSON.stringify({ namespace, name, version, displayName: name, source: 'open-vsx' })
  )
}

describe('runtime trust gating', () => {
  it('requires trust before activation (version-pinned, acknowledged bypass)', async () => {
    const { dir, service } = openHarness()
    try {
      craftInstalled(dir, 'acme', 'tool', '1.0.0', { main: './out/entry.js', activationEvents: ['onCommand:acme.run'] })
      const identity = { namespace: 'acme', name: 'tool', version: '1.0.0' }
      assert.equal(service.isTrusted(identity), false)
      await assert.rejects(service.activateExtension(identity), /permission/)
      // Acknowledged (explicit user action) bypasses for one run.
      // Host has no matching provider path here; activation proceeds
      // to the host round-trip and times out fast — the trust gate
      // itself is what this asserts (no trust-required error).
      await assert.rejects(service.activateExtension(identity, { acknowledged: true }), /timed out|unavailable|activated|could not be activated/)
      service.setTrusted(identity, true)
      assert.equal(service.isTrusted(identity), true)
      // A new version never inherits trust.
      assert.equal(service.isTrusted({ namespace: 'acme', name: 'tool', version: '2.0.0' }), false)
      void writeExtensionTrust
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runtime triggers', () => {
  it('evaluates language triggers without auto-running untrusted extensions', async () => {
    const { dir, service } = openHarness()
    try {
      craftInstalled(dir, 'acme', 'linter', '1.0.0', { main: './out/entry.js', activationEvents: ['onLanguage:typescript'] })
      const outcome = await service.fireTrigger({ kind: 'language', value: 'typescript' })
      assert.deepEqual(outcome.activated, [])
      assert.deepEqual(outcome.needsTrust, ['acme.linter@1.0.0'])
      // Unrelated languages match nothing.
      assert.deepEqual((await service.fireTrigger({ kind: 'language', value: 'python' })).needsTrust, [])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never auto-runs star extensions', async () => {
    const { dir, service } = openHarness()
    try {
      craftInstalled(dir, 'acme', 'star', '1.0.0', { main: './out/entry.js', activationEvents: ['*'] })
      assert.deepEqual((await service.fireTrigger({ kind: 'startup' })).needsTrust, [])
      assert.deepEqual((await service.fireTrigger({ kind: 'language', value: 'typescript' })).needsTrust, [])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches workspace patterns and startup declarations', async () => {
    const { dir, service } = openHarness()
    try {
      craftInstalled(dir, 'acme', 'ws', '1.0.0', { main: './out/entry.js', activationEvents: ['workspaceContains:package.json'] })
      craftInstalled(dir, 'acme', 'boot', '1.0.0', { main: './out/entry.js', activationEvents: ['onStartupFinished'] })
      assert.deepEqual((await service.fireTrigger({ kind: 'workspace', rootEntries: ['package.json'] })).needsTrust, ['acme.ws@1.0.0'])
      assert.deepEqual((await service.fireTrigger({ kind: 'workspace', rootEntries: ['README.md'] })).needsTrust, [])
      assert.deepEqual((await service.fireTrigger({ kind: 'startup' })).needsTrust, ['acme.boot@1.0.0'])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runtime host cooperation', () => {
  it('answers findFiles/openDocument from workspace-owned paths only', async () => {
    const { dir, posted, listeners, service } = openHarness()
    try {
      void service
      emit(listeners, 'HOST_REQUEST', { requestId: 'r1', type: 'findFiles', payload: { pattern: '*.json', maxResults: 10 } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const reply = posted.find((message) => (message as { type?: string }).type === 'HOST_RESPONSE') as
        | { payload: { requestId: string; response: { uris: string[] } } }
        | undefined
      assert.ok(reply !== undefined)
      assert.deepEqual(reply.payload.response.uris, ['file:/root/package.json'])
      emit(listeners, 'HOST_REQUEST', { requestId: 'r2', type: 'openDocument', payload: { uri: 'file:package.json' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const replies = posted.filter((message) => (message as { type?: string }).type === 'HOST_RESPONSE') as {
        payload: { requestId: string; response: unknown }
      }[]
      assert.equal(replies.length, 2)
      // Outside-workspace reads resolve to null (containment).
      emit(listeners, 'HOST_REQUEST', { requestId: 'r3', type: 'openDocument', payload: { uri: 'file:/etc/passwd' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const third = (posted.filter((message) => (message as { type?: string }).type === 'HOST_RESPONSE') as {
        payload: { requestId: string; response: unknown }
      }[]).find((entry) => entry.payload.requestId === 'r3')
      assert.equal(third?.payload.response, null)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('queues prompts for renderer round-trips with bounded resolution', async () => {
    const { dir, listeners, service } = openHarness()
    try {
      const seen: { promptId: string }[] = []
      service.setPromptListener((prompt) => {
        seen.push({ promptId: prompt.promptId })
      })
      emit(listeners, 'HOST_REQUEST', { requestId: 'p1', type: 'showQuickPick', payload: { owner: 'a.b@1.0.0', items: ['x'] } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(seen.length, 1)
      assert.equal(service.listPrompts().length, 1)
      assert.equal(service.resolvePrompt('p1', { selected: 'x' }), true)
      assert.equal(service.listPrompts().length, 0)
      assert.equal(service.resolvePrompt('missing', {}), false)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes notifications, diagnostics, proposals, storage, and config', async () => {
    const { dir, listeners, service } = openHarness()
    try {
      emit(listeners, 'EXTENSION_NOTIFY', { notify: 'MESSAGE_SHOWN', owner: 'a.b@1.0.0', severity: 'error', message: 'boom' })
      assert.equal(service.listNotifications().length, 1)
      emit(listeners, 'EXTENSION_NOTIFY', {
        notify: 'DIAGNOSTICS_CHANGED',
        owner: 'a.b@1.0.0',
        collection: 'c',
        entries: [{ uri: 'file:a', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 0, message: 'm' }] }]
      })
      assert.equal(service.listDiagnostics('file:a').length, 1)
      emit(listeners, 'EXTENSION_NOTIFY', {
        notify: 'EDIT_PROPOSAL',
        owner: 'a.b@1.0.0',
        edits: [{ uri: 'file:a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'b' }]
      })
      assert.equal(service.listEditProposals().length, 1)
      const proposalId = service.listEditProposals()[0]?.proposalId ?? ''
      assert.equal(service.dismissProposal(proposalId), true)
      emit(listeners, 'EXTENSION_NOTIFY', { notify: 'STORAGE_WRITE', owner: 'a.b@1.0.0', scope: 'global', key: 'k', value: 'v' })
      emit(listeners, 'EXTENSION_NOTIFY', { notify: 'CONFIG_UPDATE', owner: 'a.b@1.0.0', key: 'eslint.enable', value: true })
      assert.deepEqual(service.getConfig('a.b@1.0.0'), { 'eslint.enable': true })
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds details with compat, failure, and update state (offline-safe)', async () => {
    const { dir, listeners, service } = openHarness()
    try {
      craftInstalled(dir, 'acme', 'tool', '1.0.0', {
        main: './out/entry.js',
        contributes: { commands: [{ command: 'acme.run', title: 'Run' }], themes: [{ id: 't', label: 'T', path: './t.json' }] }
      })
      emit(listeners, 'EXTENSION_ACTIVATION_ERROR', { activationId: 'a', extensionId: 'acme.tool@1.0.0', code: 'unsupported-api', unsupportedApi: 'vscode.debug' })
      const details = await service.getDetails({ namespace: 'acme', name: 'tool', version: '1.0.0' })
      assert.equal(details.compatibility, 'partial')
      assert.ok(details.reasons.some((reason) => reason.includes('vscode.debug')))
      assert.equal(details.failure, 'unsupported-api')
      assert.equal(details.commands[0]?.command, 'acme.run')
      assert.equal(details.updateAvailable, false)
      // Update checks without a catalog resolve offline-safe.
      assert.deepEqual(await service.checkUpdate({ namespace: 'acme', name: 'tool', version: '1.0.0' }), { updateAvailable: false, latestVersion: null })
      assert.equal(service.getAutoUpdate(), false)
      assert.equal(service.setAutoUpdate(true), true)
      assert.equal(service.getAutoUpdate(), true)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps schema at v19 with no migration 020', async () => {
    const { readdirSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const files = readdirSync(joinPath(process.cwd(), 'src', 'main', 'database', 'migrations')).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
    )
    assert.ok(files.includes('019-message-attachments.ts'))
    assert.ok(!files.some((file) => file.startsWith('020')))
  })
})
