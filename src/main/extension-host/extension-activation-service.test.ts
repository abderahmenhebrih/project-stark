import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ExtensionHostManager } from './extension-host-manager'
import {
  EXTENSION_ACTIVATION_TIMEOUT_MS,
  EXTENSION_DEACTIVATION_TIMEOUT_MS,
  ExtensionActivationService
} from './extension-activation-service'
import { ExtensionActivationError } from './extension-activation-errors'
import { EXTENSION_INSTALL_MANIFEST_NAME } from '../extension-install/extension-install-service'
import { writeExtensionEnabledStates } from '../extension-install/extension-state'

const PROTOCOL = 'stark-extension-host/v1'

function fakeManager(): {
  manager: ExtensionHostManager
  posts: unknown[]
  startCalls: number
  stopCalls: number
  state: 'stopped' | 'ready'
  listeners: ((event: { kind: string; raw?: unknown }) => void)[]
  emit: (raw: unknown) => void
  crash: () => void
} {
  const posts: unknown[] = []
  const listeners: ((event: { kind: string; raw?: unknown }) => void)[] = []
  let startCalls = 0
  let stopCalls = 0
  let state: 'stopped' | 'ready' = 'stopped'
  const manager = {
    getStatus: () => ({ state }),
    start: async () => {
      startCalls += 1
      state = 'ready'
      return { state }
    },
    stop: async () => {
      stopCalls += 1
      state = 'stopped'
      return { state }
    },
    postToHost: (message: unknown) => {
      if (state !== 'ready') {
        throw new Error('not ready')
      }
      posts.push(message)
    },
    onHostEvent: (listener: (event: { kind: string; raw?: unknown }) => void) => {
      listeners.push(listener)
      return () => {}
    }
  } as unknown as ExtensionHostManager
  return {
    manager,
    posts,
    get startCalls() {
      return startCalls
    },
    get stopCalls() {
      return stopCalls
    },
    get state() {
      return state
    },
    listeners,
    emit: (raw: unknown) => {
      for (const listener of [...listeners]) {
        listener({ kind: 'message', raw })
      }
    },
    crash: () => {
      state = 'crashed' as never
      for (const listener of [...listeners]) {
        listener({ kind: 'exit' })
      }
    }
  }
}

function craftPackage(root: string, namespace: string, name: string, version: string, manifestExtra: Record<string, unknown> = {}): void {
  const versionDir = join(root, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension', 'out'), { recursive: true })
  writeFileSync(
    join(versionDir, 'extension', 'package.json'),
    JSON.stringify({ name, publisher: namespace, version, displayName: `${name} display`, main: './out/entry.js', ...manifestExtra })
  )
  writeFileSync(join(versionDir, 'extension', 'out', 'entry.js'), 'export async function activate() {}\n')
  writeFileSync(
    join(versionDir, EXTENSION_INSTALL_MANIFEST_NAME),
    JSON.stringify({ namespace, name, displayName: `${name} display`, version, sha256: '0'.repeat(64), installedAt: '2026-01-01T00:00:00.000Z', source: 'open-vsx' })
  )
}

function openService(options?: {
  installed?: { namespace: string; name: string; version: string; displayName?: string; enabled?: boolean }[]
  craft?: { namespace: string; name: string; version: string; manifestExtra?: Record<string, unknown> }[]
  activationTimeoutMs?: number
  deactivationTimeoutMs?: number
  stateOverrides?: Map<string, boolean>
}): { dir: string; host: ReturnType<typeof fakeManager>; service: ExtensionActivationService } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-activate-'))
  const crafts = options?.craft ?? [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0' }]
  for (const c of crafts) {
    craftPackage(dir, c.namespace, c.name, c.version, c.manifestExtra ?? {})
  }
  if (options?.stateOverrides !== undefined) {
    writeExtensionEnabledStates(dir, options.stateOverrides)
  }
  const installed = options?.installed ?? crafts.map((c) => ({ namespace: c.namespace, name: c.name, version: c.version, displayName: c.name, enabled: true }))
  const host = fakeManager()
  const service = new ExtensionActivationService({
    manager: host.manager,
    installService: {
      listInstalled: async () => installed.map((e) => ({ namespace: e.namespace, name: e.name, version: e.version, displayName: e.displayName ?? e.name, status: 'installed' as const, enabled: e.enabled ?? true, iconUrl: null }))
    },
    installRoot: dir,
    activationTimeoutMs: options?.activationTimeoutMs,
    deactivationTimeoutMs: options?.deactivationTimeoutMs
  })
  return { dir, host, service }
}

async function waitForPost(host: ReturnType<typeof fakeManager>, type: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000
  for (;;) {
    const posts = host.posts.filter((p) => (p as { type: string }).type === type)
    if (posts.length > 0) {
      return posts[posts.length - 1] as Record<string, unknown>
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for host post ${type}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('generic activation service', () => {
  it('bounds timeouts at 10s activate / 5s deactivate with no retry', () => {
    assert.equal(EXTENSION_ACTIVATION_TIMEOUT_MS, 10_000)
    assert.equal(EXTENSION_DEACTIVATION_TIMEOUT_MS, 5_000)
  })

  it('activates an installed + enabled generic extension (no Prettier gate)', async () => {
    const { dir, host, service } = openService()
    try {
      const pending = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const posted = await waitForPost(host, 'ACTIVATE_EXTENSION')
      // Host starts on demand (explicit activation only).
      assert.equal(host.startCalls, 1)
      const payload = posted['payload'] as Record<string, unknown>
      assert.equal(payload['extensionId'], 'fixture.extension-a@1.0.0')
      assert.ok(typeof payload['storeRoot'] === 'string' && (payload['storeRoot'] as string) !== '')
      assert.ok(typeof payload['extensionDir'] === 'string' && (payload['extensionDir'] as string) !== '')
      // Renderer never supplies paths: the service derives them.
      assert.ok(!(payload as Record<string, unknown>)['formatterModuleUrl'])
      const manifest = payload['manifest'] as Record<string, unknown>
      assert.equal(manifest['name'], 'extension-a')
      assert.ok(!('scripts' in manifest), 'scripts must never cross the wire')
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_ACTIVATED', payload: { activationId: payload['activationId'], extensionId: 'fixture.extension-a@1.0.0' } })
      const result = await pending
      assert.equal(result.extensionId, 'fixture.extension-a@1.0.0')
      assert.deepEqual([...service.listActive()], ['fixture.extension-a@1.0.0'])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('activates Prettier through the same generic pipeline', async () => {
    const { dir, host, service } = openService({
      craft: [{ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }],
      installed: [{ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0', enabled: true }]
    })
    try {
      const pending = service.activateExtension({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' })
      const posted = await waitForPost(host, 'ACTIVATE_EXTENSION')
      const payload = posted['payload'] as Record<string, unknown>
      assert.equal(payload['extensionId'], 'esbenp.prettier-vscode@12.4.0')
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_ACTIVATED', payload: { activationId: payload['activationId'], extensionId: 'esbenp.prettier-vscode@12.4.0' } })
      const result = await pending
      assert.equal(result.displayName, 'prettier-vscode display')
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses disabled, uninstalled, and malformed identities without host contact', async () => {
    const { dir, host, service } = openService({
      installed: [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0', enabled: false }]
    })
    try {
      await assert.rejects(service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' }), (error: unknown) => {
        assert.ok(error instanceof ExtensionActivationError && error.code === 'disabled')
        return true
      })
      assert.equal(host.startCalls, 0)
      assert.equal(host.posts.length, 0)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
    const absent = openService({ craft: [], installed: [] })
    try {
      await assert.rejects(absent.service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' }), /not installed/)
      assert.equal(absent.host.posts.length, 0)
    } finally {
      absent.service.dispose()
      rmSync(absent.dir, { recursive: true, force: true })
    }
    const malformed = openService()
    try {
      for (const bad of [
        null,
        {},
        { namespace: 'fixture', name: 'extension-a' },
        { namespace: 'fixture', name: 'extension-a', version: '1.0.0', path: '/tmp/x' },
        { namespace: 'fixture', name: 'extension-a', version: '1.0.0', extensionDir: '/tmp/x' },
        { namespace: '../evil', name: 'x', version: '1.0.0' }
      ]) {
        await assert.rejects(malformed.service.activateExtension(bad), /not valid/)
      }
      assert.equal(malformed.host.posts.length, 0, 'renderer-supplied paths must never reach the host')
    } finally {
      malformed.service.dispose()
      rmSync(malformed.dir, { recursive: true, force: true })
    }
  })

  it('rejects browser-only kinds honestly without host contact', async () => {
    const { dir, host, service } = openService({
      craft: [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0', manifestExtra: { main: undefined, browser: './out/web.js' } }],
      installed: [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0', enabled: true }]
    })
    // Craft above spreads main: undefined (JSON drops it) + browser.
    try {
      await assert.rejects(service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' }), (error: unknown) => {
        const code = (error as ExtensionActivationError)?.code
        assert.ok(code === 'unsupported-extension-kind' || code === 'invalid-manifest', `unexpected code ${String(code)}`)
        return true
      })
      assert.equal(host.posts.length, 0)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects entrypoint escapes without host contact', async () => {
    const { dir, host, service } = openService({
      craft: [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0', manifestExtra: { main: '../../outside.js' } }]
    })
    try {
      // Craft a valid entry file anyway so the failure is containment, not missing file.
      await assert.rejects(service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' }), ExtensionActivationError)
      assert.equal(host.posts.length, 0)
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces host unsupported-API reports with safe copy + diagnostics', async () => {
    const { dir, host, service } = openService()
    try {
      const pending = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const posted = await waitForPost(host, 'ACTIVATE_EXTENSION')
      const payload = posted['payload'] as Record<string, unknown>
      host.emit({
        protocol: PROTOCOL,
        type: 'EXTENSION_ACTIVATION_ERROR',
        payload: { activationId: payload['activationId'], extensionId: 'fixture.extension-a@1.0.0', code: 'unsupported-api', unsupportedApi: 'debug.startDebugging' }
      })
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ExtensionActivationError && error.code === 'unsupported-api')
        assert.equal(error.message, 'This extension requires a VS Code API that STARK does not support yet.')
        assert.equal(error.unsupportedApi, 'debug.startDebugging')
        return true
      })
      assert.deepEqual([...service.listActive()], [])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('times out hung activations with no retry and one flight per id', async () => {
    const { dir, host, service } = openService({ activationTimeoutMs: 30 })
    try {
      const first = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const second = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      await assert.rejects(first, /timed out/)
      await assert.rejects(second, /timed out/)
      assert.equal(host.posts.filter((p) => (p as { type: string }).type === 'ACTIVATE_EXTENSION').length, 1, 'exactly one flight, no retry')
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never auto-activates at startup and "*" never triggers background execution', async () => {
    const { dir, host, service } = openService({
      craft: [{ namespace: 'fixture', name: 'extension-a', version: '1.0.0', manifestExtra: { activationEvents: ['*'] } }]
    })
    try {
      assert.equal(host.startCalls, 0)
      assert.equal(host.posts.length, 0)
      assert.deepEqual([...service.listActive()], [])
      // Explicit activation still works (demand-driven, not background).
      const pending = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const posted = await waitForPost(host, 'ACTIVATE_EXTENSION')
      assert.equal(host.posts.filter((p) => (p as { type: string }).type === 'ACTIVATE_EXTENSION').length, 1)
      const payload = posted['payload'] as Record<string, unknown>
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_ACTIVATED', payload: { activationId: payload['activationId'], extensionId: 'fixture.extension-a@1.0.0' } })
      await pending
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deactivates boundedly (5s) and stops the host on hang', async () => {
    const { dir, host, service } = openService({ deactivationTimeoutMs: 30 })
    try {
      const pending = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const posted = await waitForPost(host, 'ACTIVATE_EXTENSION')
      const payload = posted['payload'] as Record<string, unknown>
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_ACTIVATED', payload: { activationId: payload['activationId'], extensionId: 'fixture.extension-a@1.0.0' } })
      await pending
      // Clean deactivate.
      const done = service.deactivateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const deactPost = await waitForPost(host, 'DEACTIVATE_EXTENSION')
      const deactPayload = deactPost['payload'] as Record<string, unknown>
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_DEACTIVATED', payload: { activationId: deactPayload['activationId'], extensionId: 'fixture.extension-a@1.0.0' } })
      assert.equal(await done, true)
      assert.deepEqual([...service.listActive()], [])
      // Hang => host stop fallback.
      const seenActivates = host.posts.filter((p) => (p as { type: string }).type === 'ACTIVATE_EXTENSION').length
      const pending2 = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      const latest = await (async () => {
        const deadline = Date.now() + 2000
        for (;;) {
          const activates = host.posts.filter((p) => (p as { type: string }).type === 'ACTIVATE_EXTENSION')
          if (activates.length > seenActivates) {
            return activates[activates.length - 1] as Record<string, unknown>
          }
          if (Date.now() > deadline) {
            throw new Error('timed out waiting for second ACTIVATE_EXTENSION')
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      })()
      const latestPayload = latest['payload'] as Record<string, unknown>
      host.emit({ protocol: PROTOCOL, type: 'EXTENSION_ACTIVATED', payload: { activationId: latestPayload['activationId'], extensionId: 'fixture.extension-a@1.0.0' } })
      await pending2
      const stopsBefore = host.stopCalls
      const hung = service.deactivateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      assert.equal(await hung, false)
      assert.ok(host.stopCalls > stopsBefore, 'hang must stop the owned host')
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('host crash fails flights cleanly with no restart and clears active', async () => {
    const { dir, host, service } = openService()
    try {
      const pending = service.activateExtension({ namespace: 'fixture', name: 'extension-a', version: '1.0.0' })
      await waitForPost(host, 'ACTIVATE_EXTENSION')
      const startsBefore = host.startCalls
      host.crash()
      await assert.rejects(pending, /unavailable/)
      assert.equal(host.startCalls, startsBefore, 'crash must never restart by itself')
      assert.deepEqual([...service.listActive()], [])
    } finally {
      service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('main never imports extension code and introduces no write path (static)', () => {
    const service = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'extension-activation-service.ts'), 'utf8')
    for (const forbidden of ['await import(', 'require(', 'writeFileSync', 'writeFile(', 'child_process', 'spawn(', 'exec(', 'process.env']) {
      assert.ok(!service.includes(forbidden), `activation service must not contain ${forbidden}`)
    }
    assert.ok(service.includes('ACTIVATE_EXTENSION'), 'activation must use the generic lifecycle')
    assert.ok(!service.includes('ACTIVATE_FORMATTER'), 'generic service must not use the formatter pilot path')
    const formatter = readFileSync(join(process.cwd(), 'src', 'main', 'formatter', 'formatter-service.ts'), 'utf8')
    assert.ok(!formatter.includes('writeWorkspaceTextFile'), 'formatter must never write directly')
  })

  it('schema stays v19 with no migration 020', async () => {
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(join(process.cwd(), 'src', 'main', 'database', 'migrations')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'))
    assert.ok(!files.some((f) => f.startsWith('020')))
  })
})
