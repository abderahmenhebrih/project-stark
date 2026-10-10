import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  handleExtensionMessage: (message: unknown, channel: unknown) => Promise<void>
  runProviderQuery: (args: {
    kind: string
    filePath: string
    languageId: string
    text: string
    position?: { line: number; character: number }
  }) => Promise<unknown>
  executeHostCommand: (args: { command: string; args?: unknown[] }) => Promise<unknown>
  __listActive: () => string[]
  __resetForTests: () => void
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

function craftExtension(root: string, namespace: string, name: string, version: string, manifest: Record<string, unknown>, file: string, entry: string): string {
  const versionDir = join(root, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension', 'out'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version, ...manifest }))
  writeFileSync(join(versionDir, 'extension', 'out', file), entry)
  return versionDir
}

function fakeChannel(): { posts: { type: string; payload: unknown }[]; postMessage: (type: string, payload: unknown) => void } {
  const posts: { type: string; payload: unknown }[] = []
  return {
    posts,
    postMessage: (type: string, payload: unknown) => {
      posts.push({ type, payload })
    }
  }
}

const CJS_ENTRY = `
const vscode = require('vscode');
const local = require('./helper.js');
exports.activate = async function () {
  vscode.commands.registerCommand('cjs.cmd', () => 'cjs-' + local.suffix);
};
`

const CJS_DEFAULT_ENTRY = `
const vscode = require('vscode');
module.exports = {
  async activate() {
    vscode.commands.registerCommand('cjsdefault.cmd', () => 'cjs-default');
  }
};
`

const ESM_ENTRY = `
import { languages, Diagnostic, Range, Uri } from 'vscode';
export async function activate(context) {
  languages.registerCompletionItemProvider('typescript', {
    async provideCompletionItems() {
      return [{ label: 'thing', kind: 1 }];
    }
  });
  languages.registerHoverProvider('typescript', {
    async provideHover() {
      return { contents: ['hover-text'] };
    }
  });
  languages.registerDefinitionProvider('typescript', {
    async provideDefinition() {
      return [{ uri: Uri.parse('file:/a.ts'), range: new Range(0, 0, 0, 3) }];
    }
  });
  const collection = languages.createDiagnosticCollection('test');
  collection.set(Uri.parse('file:/a.ts'), [new Diagnostic(new Range(0, 0, 0, 3), 'bad', 0)]);
}
`

describe('step 8 host runtime: CommonJS compatibility', () => {
  it("require('vscode') resolves to the STARK shim (same module as ESM)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-cjs-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'cjs', 'ext', '1.0.0', { main: './out/entry.cjs' }, 'entry.cjs', CJS_ENTRY)
      mkdirSync(join(root, 'cjs.ext', '1.0.0', 'extension', 'out'), { recursive: true })
      writeFileSync(join(root, 'cjs.ext', '1.0.0', 'extension', 'out', 'helper.js'), 'exports.suffix = "ok";\n')
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'cjs.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      const execute = fakeChannel()
      await host.handleExtensionMessage({ type: 'EXECUTE_COMMAND', payload: { requestId: 'r1', command: 'cjs.cmd', args: [] } }, execute)
      const result = execute.posts[execute.posts.length - 1]
      assert.equal(result?.type, 'COMMAND_RESULT')
      assert.equal((result?.payload as Record<string, unknown>)['result'], 'cjs-ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supports module.exports = { activate } (CJS default interop)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-cjs-default-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'cjsd', 'ext', '1.0.0', { main: './out/entry.cjs' }, 'entry.cjs', CJS_DEFAULT_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'cjsd.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates no arbitrary module remapping (local + deps resolve normally)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-cjs-remap-'))
    try {
      const host = await loadHost()
      const entry = `
const vscode = require('vscode');
const local = require('./helper.js');
const path = require('node:path');
exports.activate = async function () {
  if (typeof vscode.commands.registerCommand !== 'function') throw new Error('shim broken');
  if (local.marker !== 'local-ok') throw new Error('local resolution broken');
  if (typeof path.join !== 'function') throw new Error('builtin resolution broken');
  vscode.commands.registerCommand('remap.cmd', () => 1);
};
`
      const versionDir = craftExtension(root, 'remap', 'ext', '1.0.0', { main: './out/entry.cjs' }, 'entry.cjs', entry)
      writeFileSync(join(root, 'remap.ext', '1.0.0', 'extension', 'out', 'helper.js'), 'exports.marker = "local-ok";\n')
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'remap.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('step 8 host runtime: language features', () => {
  it('queries completion, hover, and definition across active providers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-prov-'))
    try {
      const host = await loadHost()
      const versionDir = craftExtension(root, 'prov', 'ext', '1.0.0', { main: './out/entry.mjs' }, 'entry.mjs', ESM_ENTRY)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'prov.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      const completion = (await host.runProviderQuery({ kind: 'completion', filePath: '/a.ts', languageId: 'typescript', text: 'const x = 1\n', position: { line: 0, character: 5 } })) as { items: { label: string }[] }
      assert.equal(completion.items[0]?.label, 'thing')
      const hover = (await host.runProviderQuery({ kind: 'hover', filePath: '/a.ts', languageId: 'typescript', text: 'const x = 1\n', position: { line: 0, character: 1 } })) as { contents: string }
      assert.equal(hover.contents, 'hover-text')
      const definition = (await host.runProviderQuery({ kind: 'definition', filePath: '/a.ts', languageId: 'typescript', text: 'const x = 1\n', position: { line: 0, character: 1 } })) as { locations: unknown[] }
      assert.equal(definition.locations.length, 1)
      // Diagnostics notify main (bounded, normalized).
      assert.ok(channel.posts.some((post) => post.type === 'EXTENSION_NOTIFY' && (post.payload as Record<string, unknown>)['notify'] === 'DIAGNOSTICS_CHANGED'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unknown provider kinds without crashing', async () => {
    const host = await loadHost()
    await assert.rejects(
      host.runProviderQuery({ kind: 'teleport', filePath: '/a.ts', languageId: 'typescript', text: 'x' }),
      /Unknown provider query/
    )
  })
})

describe('step 8 host runtime: spawn guard', () => {  it('blocks shell execution and tracks exact-owned spawns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-guard-'))
    try {
      const host = await loadHost()
      const entry = `
const cp = require('node:child_process');
exports.activate = async function () {
  let blocked = false;
  try { cp.exec('echo hi', () => {}); } catch (e) { blocked = /shell/.test(e.message); }
  if (!blocked) throw new Error('shell exec must fail closed');
  const child = cp.spawn(process.execPath, ['--version']);
  await new Promise((resolve) => child.on('exit', resolve));
};
`
      const versionDir = craftExtension(root, 'guard', 'ext', '1.0.0', { main: './out/entry.cjs' }, 'entry.cjs', entry)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'guard.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      assert.ok(channel.posts.some((post) => post.type === 'EXTENSION_NOTIFY' && (post.payload as Record<string, unknown>)['notify'] === 'PROCESS_SPAWNED'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('step 9 host runtime: declarative contributions', () => {
  it('activates theme/snippet manifests as a no-op without running code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-declarative-'))
    try {
      const host = await loadHost()
      const themeDir = craftExtension(
        root,
        'theme',
        'dark',
        '1.0.0',
        { contributes: { themes: [{ id: 'd', label: 'Dark', path: './themes/dark.json' }] } },
        'placeholder.js',
        'export const x = 1;\n'
      )
      mkdirSync(join(themeDir, 'extension', 'themes'), { recursive: true })
      writeFileSync(join(themeDir, 'extension', 'themes', 'dark.json'), '{}')
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 't1', extensionId: 'theme.dark@1.0.0', storeRoot: root, extensionDir: themeDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      // No code runs: declarative extensions never join the active set.
      assert.deepEqual(host.__listActive(), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still rejects browser-only and executable-without-entrypoint manifests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-declarative-bad-'))
    try {
      const host = await loadHost()
      const webDir = craftExtension(root, 'web', 'only', '1.0.0', { browser: './out/web.js' }, 'entry.js', 'export const x = 1;\n')
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 't1', extensionId: 'web.only@1.0.0', storeRoot: root, extensionDir: webDir, manifest: {} } },
        channel
      )
      assert.equal((channel.posts[channel.posts.length - 1]?.payload as Record<string, unknown>)['code'], 'unsupported-extension-kind')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('queries code lens and document links through new providers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-lens-'))
    try {
      const host = await loadHost()
      const entry = `
import * as vscode from 'vscode';
export async function activate() {
  vscode.languages.registerCodeLensProvider('typescript', {
    async provideCodeLenses() {
      return [{ range: new vscode.Range(0, 0, 0, 4) }];
    }
  });
  vscode.languages.registerDocumentLinkProvider('typescript', {
    async provideDocumentLinks() {
      return [{ range: new vscode.Range(0, 0, 0, 4), target: vscode.Uri.parse('file:/b.ts') }];
    }
  });
  vscode.languages.registerCallHierarchyProvider('typescript', {
    async prepareCallHierarchy() {
      return null;
    }
  });
}
`
      const versionDir = craftExtension(root, 'lens', 'ext', '1.0.0', { main: './out/entry.mjs' }, 'entry.mjs', entry)
      const channel = fakeChannel()
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 't1', extensionId: 'lens.ext@1.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
      const lenses = (await host.runProviderQuery({ kind: 'codeLens', filePath: '/a.ts', languageId: 'typescript', text: 'x\n' })) as { lenses: unknown[] }
      assert.equal(lenses.lenses.length, 1)
      const links = (await host.runProviderQuery({ kind: 'documentLink', filePath: '/a.ts', languageId: 'typescript', text: 'x\n' })) as { links: { target: string }[] }
      assert.equal(links.links[0]?.target, 'file:/b.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
