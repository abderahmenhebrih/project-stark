import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Prettier-pilot host tests: the real STARK-owned formatter module,
 * shim, and loader against crafted fixture extensions (no network,
 * no registry). The real esbenp.prettier-vscode package is exercised
 * separately in bounded live verification; the suite must not depend
 * on internet or machine state.
 */

const SHIM_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs')
const HOST_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'formatter-host.mjs')
const LOADER_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-loader.mjs')

/**
 * Loads a STARK-owned .mjs host module from the CommonJS test
 * build. Dynamic import() expressions compile to require() here, so
 * file URLs fail; instead require the absolute path (Node 22
 * require(esm)) through a require rooted at this test file.
 */
async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

async function loadHost(): Promise<Record<string, (...args: Array<never>) => unknown>> {
  return loadMjs<Record<string, (...args: Array<never>) => unknown>>(HOST_PATH)
}

const FIXTURE_ENTRY = `
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

const HOSTILE_ENTRY = `
export async function activate() {
  throw new Error('hostile crash');
}
`

function craftExtension(root: string, namespace: string, name: string, version: string, manifest: Record<string, unknown>, entry: string): string {
  const versionDir = join(root, `${namespace}.${name}`, version)
  mkdirSync(join(versionDir, 'extension'), { recursive: true })
  writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version, ...manifest }))
  writeFileSync(join(versionDir, 'extension', 'entry.js'), entry)
  return versionDir
}

function pilotFixture(root: string): string {
  return craftExtension(root, 'esbenp', 'prettier-vscode', '9.9.9', { main: './entry.js' }, FIXTURE_ENTRY)
}

function fakeChannel(): { posts: { type: string; payload: unknown }[]; postMessage: (type: string, payload: unknown) => void; fail: (reason: string) => void } {
  const posts: { type: string; payload: unknown }[] = []
  return {
    posts,
    postMessage: (type: string, payload: unknown) => {
      posts.push({ type, payload })
    },
    fail: () => {}
  }
}

describe('vscode shim (audited explicit surface)', () => {
  it('exports exactly the audited names with no Proxy', async () => {
    const shim = await loadMjs<Record<string, unknown>>(SHIM_PATH)
    assert.deepEqual(Object.keys(shim).sort(), [
      'CallHierarchyItem',
      'CancellationError',
      'CancellationToken',
      'CancellationTokenSource',
      'CodeAction',
      'CodeActionKind',
      'CodeLens',
      'CompletionItem',
      'CompletionItemKind',
      'CompletionItemTag',
      'CompletionList',
      'Diagnostic',
      'DiagnosticSeverity',
      'DiagnosticTag',
      'Disposable',
      'DocumentHighlight',
      'DocumentHighlightKind',
      'DocumentLink',
      'DocumentSymbol',
      'EndOfLine',
      'EventEmitter',
      'FileChangeType',
      'FileType',
      'FoldingRange',
      'FoldingRangeKind',
      'Hover',
      'InlayHint',
      'InlayHintKind',
      'InsertTextMode',
      'LanguageStatusSeverity',
      'Location',
      'MarkdownString',
      'Memento',
      'OverviewRulerLane',
      'ParameterInformation',
      'Position',
      'ProgressLocation',
      'Range',
      'RelativePattern',
      'Selection',
      'SelectionRange',
      'SignatureHelp',
      'SignatureHelpTriggerKind',
      'SignatureInformation',
      'SnippetString',
      'StatusBarAlignment',
      'SymbolInformation',
      'SymbolKind',
      'SymbolTag',
      'TextDocumentSaveReason',
      'TextEdit',
      'ThemeColor',
      'ThemeIcon',
      'TypeHierarchyItem',
      'Uri',
      'ViewColumn',
      'WorkspaceEdit',
      '__applyDocumentEvent',
      '__clearActiveExtensionId',
      '__dispatchWatcherEvent',
      '__disposeOwner',
      '__getActiveExtensionId',
      '__getAllDiagnostics',
      '__getCommandOwner',
      '__getOwnerRegistrations',
      '__registerExtensionInfo',
      '__resetForTests',
      '__setActiveEditor',
      '__setActiveExtensionId',
      '__setExtensionSnapshots',
      '__setHostNotify',
      '__setHostRequestHandler',
      '__setWorkspaceFolders',
      '__unregisterExtensionInfo',
      'authentication',
      'commands',
      'debug',
      'env',
      'extensions',
      'languages',
      'notebooks',
      'scm',
      'tasks',
      'timeline',
      'version',
      'window',
      'workspace'
    ].sort())
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs'), 'utf8')
    assert.ok(!source.includes('new Proxy('), 'shim must not use a catch-all Proxy')
    assert.ok(!source.includes('require('), 'shim must stay dependency-free')
  })

  it('fails clearly on unlisted APIs and reports the pilot trust posture', async () => {
    const shim = await loadMjs<{
      languages: { match: () => void }
      commands: {
        registerCommand: (id: string, handler: () => unknown) => { dispose: () => void }
        executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>
      }
      __setActiveExtensionId: (id: string) => void
      __clearActiveExtensionId: () => void
      __resetForTests: () => void
      window: { showOpenDialog: () => void }
      workspace: { isTrusted: boolean; workspaceFolders: unknown; getWorkspaceFolder: () => unknown; getConfiguration: (s: string) => { get: (k: string, d: unknown) => unknown } }
      CodeActionKind: { SourceFixAll: { append: (p: string) => { value: string } } }
    }>(SHIM_PATH)
    shim.__resetForTests()
    assert.throws(() => shim.languages.match(), /Unsupported VS Code API: languages\.match/)
    assert.throws(() => shim.window.showOpenDialog(), /Unsupported VS Code API: window\.showOpenDialog/)
    // commands.executeCommand now dispatches owner-aware registrations
    // with a nesting bound (unknown commands reject honestly).
    shim.__setActiveExtensionId('fixture.exec@1.0.0')
    shim.commands.registerCommand('fixture.exec.hello', () => 'hi')
    shim.__clearActiveExtensionId()
    assert.equal(await shim.commands.executeCommand('fixture.exec.hello'), 'hi')
    await assert.rejects(shim.commands.executeCommand('fixture.exec.missing'), /not found/)
    shim.__resetForTests()
    assert.equal(shim.workspace.isTrusted, false)
    assert.equal(shim.workspace.workspaceFolders, undefined)
    assert.equal(shim.workspace.getWorkspaceFolder(), undefined)
    const config = shim.workspace.getConfiguration('prettier')
    assert.equal(config.get('enable', false), true)
    assert.equal(config.get('printWidth', 0), 80)
    assert.equal(config.get('endOfLine', ''), 'lf')
    assert.equal({ ...config }['printWidth' as never], 80)
    assert.equal(shim.CodeActionKind.SourceFixAll.append('prettier').value, 'source.fixAll.prettier')
  })
})

describe('vscode loader', () => {
  it('maps only the vscode specifier to the shim', async () => {
    const loader = await loadMjs<{
      resolve: (spec: string, ctx: unknown, next: (s: string, c: unknown) => Promise<{ url: string }>) => Promise<{ url: string; shortCircuit?: boolean }>
    }>(LOADER_PATH)
    const mapped = await loader.resolve('vscode', {}, async () => ({ url: 'next' }))
    assert.ok(mapped.url.endsWith('vscode-shim.mjs'))
    assert.equal(mapped.shortCircuit, true)
    let passthrough = ''
    await loader.resolve('prettier', {}, async (s: string) => {
      passthrough = s
      return { url: 'next-prettier' }
    })
    assert.equal(passthrough, 'prettier')
  })
})

describe('formatter host activation boundaries', () => {
  it('activates the allowlisted fixture and formats through the captured provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-fmt-host-'))
    try {
      const host = await loadHost()
      ;(host['__resetForTests'] as () => void)()
      const versionDir = pilotFixture(root)
      const channel = fakeChannel()
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'ACTIVATE_FORMATTER', payload: { activationId: 'a1', storeRoot: root, extensionDir: versionDir } },
        channel
      )
      assert.deepEqual(channel.posts, [{ type: 'FORMATTER_READY', payload: { activationId: 'a1' } }])
      assert.equal((host['__isActive'] as () => boolean)(), true)
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'FORMAT_DOCUMENT', payload: { requestId: 'r1', filePath: '/w/a.js', languageId: 'javascript', text: 'const x=1\n' } },
        channel
      )
      const result = channel.posts[channel.posts.length - 1]
      assert.equal(result?.type, 'FORMAT_RESULT')
      const payload = result?.payload as unknown as { requestId: string; edits: { range: unknown; newText: string }[] }
      assert.equal(payload.requestId, 'r1')
      assert.equal(payload.edits.length, 1)
      assert.equal(payload.edits[0]?.newText, 'CONST X=1\n')
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'DEACTIVATE_FORMATTER', payload: { activationId: 'a1' } },
        channel
      )
      assert.equal(channel.posts[channel.posts.length - 1]?.type, 'FORMATTER_DEACTIVATED')
      assert.equal((host['__isActive'] as () => boolean)(), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unsupported languages without touching the provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-fmt-host-lang-'))
    try {
      const host = await loadHost()
      ;(host['__resetForTests'] as () => void)()
      const versionDir = pilotFixture(root)
      const channel = fakeChannel()
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'ACTIVATE_FORMATTER', payload: { activationId: 'a1', storeRoot: root, extensionDir: versionDir } },
        channel
      )
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'FORMAT_DOCUMENT', payload: { requestId: 'r9', filePath: '/w/a.py', languageId: 'python', text: 'x=1\n' } },
        channel
      )
      assert.deepEqual(channel.posts[channel.posts.length - 1], {
        type: 'FORMAT_ERROR',
        payload: { requestId: 'r9', code: 'unsupported-language' }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('activates any verified identity generically (no Prettier allowlist) + rejects escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-fmt-host-evil-'))
    try {
      const host = await loadHost()
      const activate = host['activateFormatter'] as (args: { storeRoot: string; extensionDir: string }) => Promise<unknown>
      // Generic: a non-Prettier identity with a formatter now activates
      // through the SAME pipeline (no allowlist).
      const other = craftExtension(root, 'ms-python', 'python', '1.0.0', { main: './entry.js' }, FIXTURE_ENTRY)
      await activate({ storeRoot: root, extensionDir: other })
      assert.equal((host['__isActive'] as () => boolean)(), true)
      ;(host['__resetForTests'] as () => void)()
      // Directory escape still fails closed.
      await assert.rejects(activate({ storeRoot: root, extensionDir: join(root, '..', 'outside') }), /escapes the extension store/)
      // Manifest main escape still fails closed.
      const escapeMain = craftExtension(root, 'esbenp', 'prettier-vscode', '1.0.1', { main: '../../outside.js' }, FIXTURE_ENTRY)
      await assert.rejects(activate({ storeRoot: root, extensionDir: escapeMain }), /escapes the extension directory/)
      // Non-JS entrypoint still fails closed.
      const badExt = craftExtension(root, 'esbenp', 'prettier-vscode', '1.0.2', { main: './entry.sh' }, FIXTURE_ENTRY)
      await assert.rejects(activate({ storeRoot: root, extensionDir: badExt }), /not a JavaScript module/)
      // Missing formatter registration still fails the formatter path
      // (generic activation itself allows provider-less extensions).
      const noProvider = craftExtension(
        root,
        'esbenp',
        'prettier-vscode',
        '1.0.4',
        { main: './entry.js' },
        'export async function activate() {}\n'
      )
      await assert.rejects(activate({ storeRoot: root, extensionDir: noProvider }), /did not register a document formatter/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never enumerates siblings + hostile crash stays bounded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-fmt-host-hostile-'))
    try {
      const host = await loadHost()
      ;(host['__resetForTests'] as () => void)()
      const hostileDir = craftExtension(root, 'evil', 'malware', '1.0.0', { main: './entry.js' }, HOSTILE_ENTRY)
      const goodDir = pilotFixture(root)
      // Activating the good extension never enumerates or imports the
      // hostile sibling (only the requested directory loads).
      const channel = fakeChannel()
      await (host['handleFormatterMessage'] as (m: unknown, c: unknown) => Promise<void>)(
        { type: 'ACTIVATE_FORMATTER', payload: { activationId: 'a1', storeRoot: root, extensionDir: goodDir } },
        channel
      )
      assert.deepEqual(channel.posts, [{ type: 'FORMATTER_READY', payload: { activationId: 'a1' } }])
      // Hostile activation fails boundedly (throwing activate) without
      // crashing the host process; the good formatter still works.
      await assert.rejects(
        (host['activateFormatter'] as (args: unknown) => Promise<unknown>)({ storeRoot: root, extensionDir: hostileDir }),
        /did not register|activation failed|hostile crash/
      )
      void readFileSync
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('matches selectors minimally and computes CRLF-correct positions', async () => {
    const host = await loadHost()
    const matchSelector = host['matchSelector'] as (selector: unknown, languageId: string, scheme: string) => boolean
    assert.equal(matchSelector('javascript', 'javascript', 'file'), true)
    assert.equal(matchSelector('python', 'javascript', 'file'), false)
    assert.equal(matchSelector([{ language: 'typescript' }], 'typescript', 'file'), true)
    assert.equal(matchSelector([{ language: 'jsonc', scheme: 'vscode-userdata' }], 'jsonc', 'file'), false)
    assert.equal(matchSelector([{ language: 'jsonc', scheme: 'vscode-userdata' }], 'jsonc', 'vscode-userdata'), true)
    assert.equal(matchSelector([{ pattern: '**/*.js' }], 'javascript', 'file'), false)
    const build = host['buildSyntheticDocument'] as (args: { Uri: { file: (p: string) => unknown }; filePath: string; languageId: string; text: string }) => {
      positionAt: (offset: number) => { line: number; character: number }
      offsetAt: (position: { line: number; character: number }) => number
      getText: () => string
    }
    const shim = await loadMjs<{ Uri: { file: (p: string) => unknown } }>(SHIM_PATH)
    const doc = build({ Uri: shim.Uri, filePath: '/w/a.js', languageId: 'javascript', text: 'ab\r\ncde\nf' })
    assert.deepEqual(doc.positionAt(0), { line: 0, character: 0 })
    assert.deepEqual(doc.positionAt(4), { line: 1, character: 0 })
    assert.deepEqual(doc.offsetAt({ line: 1, character: 2 }), 6)
    assert.equal(doc.offsetAt({ line: 99, character: 5 }), doc.getText().length)
  })
})
