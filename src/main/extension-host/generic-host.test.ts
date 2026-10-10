import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const SHIM_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs')
const HOST_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'generic-host.mjs')

async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

type GenericHost = {
  activateExtension: (args: { extensionId: string; storeRoot: string; extensionDir: string; manifest?: unknown }) => Promise<unknown>
  deactivateExtension: (args: { extensionId: string }) => Promise<boolean>
  formatSnapshot: (args: { filePath: string; languageId: string; text: string }) => Promise<{ range: unknown; newText: string }[]>
  handleExtensionMessage: (message: unknown, channel: unknown) => Promise<void>
  __listActive: () => string[]
  __resetForTests: () => void
  MAX_LOADED_EXTENSIONS: number
}

async function loadHost(): Promise<GenericHost> {
  const host = await loadMjs<GenericHost>(HOST_PATH)
  host.__resetForTests()
  try {
    const shim = await loadMjs<{ __resetForTests?: () => void }>(SHIM_PATH)
    shim.__resetForTests?.()
  } catch {
    // Best effort.
  }
  return host
}

function craftExtension(root: string, namespace: string, name: string, version: string, manifest: Record<string, unknown>, entry: string): string {
  const versionDir = join(root, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension', 'out'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version, ...manifest }))
  writeFileSync(join(versionDir, 'extension', 'out', 'entry.js'), entry)
  return versionDir
}

const FORMATTER_ENTRY = `
import { languages } from 'vscode';
export async function activate(context) {
  context.subscriptions.push({ dispose() {} });
  languages.registerDocumentFormattingEditProvider([{ language: 'javascript' }], {
    async provideDocumentFormattingEdits(document) {
      const text = document.getText();
      return [{
        range: { start: document.positionAt(0), end: document.positionAt(text.length) },
        newText: text.toUpperCase()
      }];
    }
  });
}
`

const COMMAND_ENTRY_A = `
import { commands, languages } from 'vscode';
export async function activate(context) {
  commands.registerCommand('fixture-a.hello', () => 'a');
  languages.registerDocumentFormattingEditProvider('javascript', {
    async provideDocumentFormattingEdits(document) {
      return [];
    }
  });
}
`

const COMMAND_ENTRY_B = `
import { commands } from 'vscode';
export async function activate(context) {
  commands.registerCommand('fixture-b.hello', () => 'b');
}
export async function deactivate() {}
`

const CRASH_ENTRY = `
export async function activate() {
  throw new Error('boom');
}
`

const UNSUPPORTED_ENTRY = `
import { window } from 'vscode';
export async function activate() {
  window.showOpenDialog();
}
`

const NO_ACTIVATE_ENTRY = `export const x = 1;\n`

function fakeChannel(): { posts: { type: string; payload: unknown }[]; postMessage: (type: string, payload: unknown) => void } {
  const posts: { type: string; payload: unknown }[] = []
  return {
    posts,
    postMessage: (type: string, payload: unknown) => {
      posts.push({ type, payload })
    }
  }
}

describe('generic host registry', () => {
  it('activates any verified extension and reports EXTENSION_ACTIVATED (no allowlist)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'fixture', 'extension-a', '1.0.0', { main: './out/entry.js' }, FORMATTER_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.extension-a@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: { name: 'extension-a', publisher: 'fixture', version: '1.0.0' } } },
        channel
      )
      const last = channel.posts[channel.posts.length - 1]
      assert.deepEqual(last, { type: 'EXTENSION_ACTIVATED', payload: { activationId: 'a1', extensionId: 'fixture.extension-a@1.0.0' } })
      assert.deepEqual(host.__listActive(), ['fixture.extension-a@1.0.0'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects browser-only kinds without faking compatibility', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-kind-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'fixture', 'web-only', '1.0.0', { browser: './out/web.js' }, FORMATTER_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.web-only@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[0]?.type, 'EXTENSION_ACTIVATION_ERROR')
      const payload = channel.posts[0]?.payload as Record<string, unknown>
      assert.equal(payload['code'], 'unsupported-extension-kind')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats absent activate as a successful no-op (VS Code compat)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-noop-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'fixture', 'theme-only', '1.0.0', { main: './out/entry.js' }, NO_ACTIVATE_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.theme-only@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports two extensions isolated by identity (dispose A keeps B, failure keeps other)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-multi-'))
    try {
      const host = await loadHost()
      const dirA = craftExtension(root, 'fixture', 'extension-a', '1.0.0', { main: './out/entry.js' }, COMMAND_ENTRY_A)
      const dirB = craftExtension(root, 'fixture', 'extension-b', '1.0.0', { main: './out/entry.js' }, COMMAND_ENTRY_B)
      const dirCrash = craftExtension(root, 'fixture', 'crasher', '1.0.0', { main: './out/entry.js' }, CRASH_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.extension-a@1.0.0', storeRoot: root, extensionDir: dirA, manifest: {} } },
        channel
      )
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a2', extensionId: 'fixture.extension-b@1.0.0', storeRoot: root, extensionDir: dirB, manifest: {} } },
        channel
      )
      assert.deepEqual([...host.__listActive()].sort(), ['fixture.extension-a@1.0.0', 'fixture.extension-b@1.0.0'])
      // One activation failure does not remove the other.
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a3', extensionId: 'fixture.crasher@1.0.0', storeRoot: root, extensionDir: dirCrash, manifest: {} } },
        channel
      )
      const last = channel.posts[channel.posts.length - 1]
      assert.equal(last?.type, 'EXTENSION_ACTIVATION_ERROR')
      assert.deepEqual([...host.__listActive()].sort(), ['fixture.extension-a@1.0.0', 'fixture.extension-b@1.0.0'])
      // Disposing A keeps B (owner-scoped registrations).
      await host.handleExtensionMessage(
        { type: 'DEACTIVATE_EXTENSION', payload: { activationId: 'd1', extensionId: 'fixture.extension-a@1.0.0' } },
        channel
      )
      assert.deepEqual(host.__listActive(), ['fixture.extension-b@1.0.0'])
      const shim = await loadMjs<{ languages: { __getDocumentFormatters: () => { owner: string }[] }; commands: { __registeredCommands: { id: string }[] } }>(SHIM_PATH)
      // B's command survives; A's formatter is gone (B registered no formatter).
      assert.ok(shim.commands.__registeredCommands.some((c) => c.id === 'fixture-b.hello'))
      assert.ok(!shim.commands.__registeredCommands.some((c) => c.id === 'fixture-a.hello'))
      assert.equal(shim.languages.__getDocumentFormatters().length, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports unsupported VS Code APIs with exact diagnostics + safe wire code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-unsupported-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'fixture', 'needs-dialog', '1.0.0', { main: './out/entry.js' }, UNSUPPORTED_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.needs-dialog@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[0]?.type, 'EXTENSION_ACTIVATION_ERROR')
      const payload = channel.posts[0]?.payload as Record<string, unknown>
      assert.equal(payload['code'], 'unsupported-api')
      assert.ok(typeof payload['unsupportedApi'] === 'string' && (payload['unsupportedApi'] as string).includes('window.showOpenDialog'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('provides a bounded explicit ExtensionContext (storage works, secrets fail)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-context-'))
    try {
      const host = await loadHost()
      const entry = `
import { commands } from 'vscode';
export async function activate(context) {
  if (!Array.isArray(context.subscriptions)) throw new Error('no subscriptions');
  if (!context.extensionUri || !context.extensionPath) throw new Error('no extension location');
  if (typeof context.extensionMode !== 'number') throw new Error('no mode');
  if (!context.extension || !context.extension.id) throw new Error('no extension id');
  if (typeof context.asAbsolutePath !== 'function') throw new Error('no asAbsolutePath');
  // Bounded extension-owned storage works synchronously.
  await context.globalState.update('greeting', 'hello');
  if (context.globalState.get('greeting') !== 'hello') throw new Error('globalState broken');
  if (!Array.isArray(context.globalState.keys()) || !context.globalState.keys().includes('greeting')) throw new Error('keys broken');
  await context.workspaceState.update('wkey', 42);
  if (context.workspaceState.get('wkey') !== 42) throw new Error('workspaceState broken');
  // Secrets have no suitable secure primitive in the host: explicit failure.
  let threw = false;
  try { void context.secrets; } catch (e) {
    if (String(e?.message ?? '').startsWith('Unsupported VS Code API:')) threw = true;
  }
  if (!threw) throw new Error('missing explicit failure for secrets');
  commands.registerCommand('fixture-ctx.ok', () => 1);
}
`
      const versionDir = craftExtension(root, 'fixture', 'ctx-check', '1.0.0', { main: './out/entry.js' }, entry)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.ctx-check@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      // Storage write-through notifies main (no disk writes from the host path under test).
      assert.ok(channel.posts.some((post) => post.type === 'EXTENSION_NOTIFY' && (post.payload as Record<string, unknown>)['notify'] === 'STORAGE_WRITE'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces owner-scoped commands (duplicates rejected, 256 cap)', async () => {
    const shim = await loadMjs<{
      __setActiveExtensionId: (id: string) => void
      __clearActiveExtensionId: () => void
      __resetForTests: () => void
      __disposeOwner: (id: string) => void
      commands: { registerCommand: (id: string, handler: () => void) => { dispose: () => void }; __registeredCommands: { id: string }[] }
    }>(SHIM_PATH)
    shim.__resetForTests()
    try {
      shim.__setActiveExtensionId('fixture.a@1.0.0')
      shim.commands.registerCommand('shared.cmd', () => {})
      assert.throws(() => shim.commands.registerCommand('shared.cmd', () => {}), /already registered/)
      shim.__clearActiveExtensionId()
      shim.__setActiveExtensionId('fixture.b@1.0.0')
      assert.throws(() => shim.commands.registerCommand('shared.cmd', () => {}), /already registered/)
      shim.__clearActiveExtensionId()
      shim.__disposeOwner('fixture.a@1.0.0')
      shim.__setActiveExtensionId('fixture.b@1.0.0')
      shim.commands.registerCommand('shared.cmd', () => {})
      shim.__clearActiveExtensionId()
      assert.ok(shim.commands.__registeredCommands.some((c) => c.id === 'shared.cmd'))
    } finally {
      shim.__resetForTests()
    }
  })

  it('formats through the generic language registry (Prettier shape works generically)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-generic-format-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'fixture', 'extension-a', '1.0.0', { main: './out/entry.js' }, FORMATTER_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'fixture.extension-a@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      await host.handleExtensionMessage(
        { type: 'FORMAT_DOCUMENT', payload: { requestId: 'r1', filePath: '/w/a.js', languageId: 'javascript', text: 'const x=1\n' } },
        channel
      )
      const last = channel.posts[channel.posts.length - 1]
      assert.equal(last?.type, 'FORMAT_RESULT')
      const payload = last?.payload as { edits: { newText: string }[] }
      assert.equal(payload.edits[0]?.newText, 'CONST X=1\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds the registry and keeps extension contact host-owned (static)', async () => {
    const host = await loadHost()
    assert.equal(host.MAX_LOADED_EXTENSIONS, 128)
    // The audited surface files stay free of generic IPC, window
    // handles, and process spawning. The ONE deliberate exception is
    // the narrow spawn guard inside the generic host (Step 8 language
    // servers): it forces no-shell execution with bounded counts and
    // exact-handle cleanup, audited separately below.
    for (const file of ['vscode-shim.mjs', 'bootstrap.js', 'formatter-host.mjs']) {
      const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', file), 'utf8')
      for (const forbidden of ['invoke(', 'ipcRenderer', 'BrowserWindow', 'utilityProcess.fork', 'child_process']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
      assert.ok(!source.includes('OPENAI_API_KEY') && !source.includes('ANTHROPIC'), `${file} must not reference provider secrets`)
    }
    const generic = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'generic-host.mjs'), 'utf8')
    for (const forbidden of ['invoke(', 'ipcRenderer', 'BrowserWindow', 'utilityProcess.fork']) {
      assert.ok(!generic.includes(forbidden), `generic-host.mjs must not contain ${forbidden}`)
    }
    assert.ok(generic.includes('MAX_LOADED_EXTENSIONS = 128'), 'loaded extensions must stay bounded')
    assert.ok(generic.includes('MAX_COMMANDS_PER_EXTENSION'), 'registrations per extension must stay bounded')
    assert.ok(!generic.includes('esbenp'), 'generic host must not name Prettier (no allowlist)')
    // Spawn guard audit: no-shell only, bounded, exact handles.
    for (const required of ['shell: false', 'MAX_PROCESSES_PER_EXTENSION', 'Too many extension child processes']) {
      assert.ok(generic.includes(required), `spawn guard must enforce ${required}`)
    }
    for (const forbidden of ['taskkill', 'pkill', 'killall', 'shell: true', 'exec(', 'spawnSync(']) {
      assert.ok(!generic.includes(forbidden), `generic host must not contain ${forbidden}`)
    }
    const helper = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'extension-process.mjs'), 'utf8')
    for (const required of ['shell: false', 'MAX_PROCESSES_PER_EXTENSION = 4', 'MAX_PROCESSES_TOTAL = 64', 'MAX_RESTARTS_PER_SLOT = 3']) {
      assert.ok(helper.includes(required), `process helper must enforce ${required}`)
    }
    for (const forbidden of ['taskkill', 'pkill', 'killall', 'shell: true']) {
      assert.ok(!helper.includes(forbidden), `process helper must not contain ${forbidden}`)
    }
  })

  it('only the host loads third-party entrypoints (main/renderer never import them)', async () => {
    const mainService = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'extension-activation-service.ts'), 'utf8')
    assert.ok(!mainService.includes('await import('), 'main activation must never import extension code (host alone loads)')
    const generic = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'generic-host.mjs'), 'utf8')
    assert.ok(generic.includes('await import(entryUrl)'), 'host alone must load the verified entrypoint')
  })
})
