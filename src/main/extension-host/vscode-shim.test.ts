import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const SHIM_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs')

async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

type Shim = {
  __setActiveExtensionId: (id: string | null) => void
  __clearActiveExtensionId: () => void
  __resetForTests: () => void
  __setHostRequestHandler: (handler: ((type: string, payload: unknown, timeoutMs: number) => Promise<unknown>) | null) => void
  __setHostNotify: (handler: ((type: string, payload: unknown) => void) | null) => void
  __setExtensionSnapshots: (id: string, snapshots: unknown) => void
  __getOwnerRegistrations: (owner: string) => Record<string, unknown>
  __disposeOwner: (owner: string) => void
  __getAllDiagnostics: () => { owner: string; uri: string; diagnostics: unknown[] }[]
  __applyDocumentEvent: (event: unknown) => void
  __dispatchWatcherEvent: (watcherId: number, kind: string, uri: string) => void
  Disposable: new (handler: () => void) => { dispose: () => void }
  EventEmitter: new () => { event: (listener: (data: unknown) => void) => { dispose: () => void }; fire: (data: unknown) => void }
  CancellationTokenSource: new () => { token: { isCancellationRequested: boolean }; cancel: () => void }
  Uri: { file: (p: string) => { toString: () => string }; parse: (s: string) => { toString: () => string } }
  Position: new (line: number, character: number) => { line: number; character: number }
  Range: new (a: number, b: number, c: number, d: number) => { start: { line: number }; end: { line: number }; contains: (p: unknown) => boolean }
  Selection: new (a: number, b: number, c: number, d: number) => { anchor: unknown }
  Diagnostic: new (range: unknown, message: string, severity?: number) => { message: string }
  RelativePattern: new (base: unknown, pattern: string) => { pattern: string }
  WorkspaceEdit: new () => { replace: (uri: unknown, range: unknown, text: string) => void; entries: unknown[] }
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { dispose: () => void }
    executeCommand: (id: string, ...args: unknown[]) => Promise<unknown>
    getCommands: () => Promise<string[]>
  }
  workspace: {
    getConfiguration: (section: string) => {
      get: (key: string, dflt: unknown) => unknown
      has: (key: string) => boolean
      inspect: (key: string) => { defaultValue: unknown; globalValue: unknown }
      update: (key: string, value: unknown) => Promise<void>
    }
    textDocuments: unknown[]
    onDidOpenTextDocument: (listener: (doc: unknown) => void) => { dispose: () => void }
    createFileSystemWatcher: (pattern: string) => {
      onDidChange: (listener: (uri: unknown) => void) => { dispose: () => void }
      dispose: () => void
    }
    findFiles: (pattern: string) => Promise<unknown[]>
    openTextDocument: (uri: string) => Promise<unknown>
    applyEdit: (edit: unknown) => Promise<boolean>
    fs: {
      readFile: (uri: unknown) => Promise<Uint8Array>
      writeFile: (uri: unknown, content: Uint8Array) => Promise<void>
    }
  }
  window: {
    showInformationMessage: (message: string, ...items: string[]) => Promise<undefined>
    showQuickPick: (items: string[]) => Promise<unknown>
    showInputBox: (options: unknown) => Promise<unknown>
    withProgress: (options: unknown, task: (progress: unknown, token: unknown) => Promise<string>) => Promise<string>
    createOutputChannel: (name: string) => { append: (v: string) => void; appendLine: (v: string) => void; dispose: () => void }
    createStatusBarItem: (alignment?: number) => { text: string; command: string | undefined; show: () => void; dispose: () => void }
    activeTextEditor: unknown
  }
  languages: {
    registerCompletionItemProvider: (selector: string, provider: { provideCompletionItems: () => void }) => { dispose: () => void }
    createDiagnosticCollection: (name: string) => {
      set: (uri: unknown, diagnostics: unknown[]) => void
      delete: (uri: unknown) => void
      clear: () => void
      dispose: () => void
    }
  }
  Memento: new (owner: string, scope: string, initial: Record<string, unknown>) => {
    get: (key: string, dflt?: unknown) => unknown
    keys: () => string[]
    update: (key: string, value: unknown) => Promise<void>
  }
  tasks: { executeTask: () => void }
  debug: { startDebugging: () => void }
  version: string
}

async function freshShim(): Promise<Shim> {
  const shim = await loadMjs<Shim>(SHIM_PATH)
  shim.__resetForTests()
  return shim
}

describe('vscode shim core types', () => {
  it('implements Disposable, EventEmitter, and CancellationToken deterministically', async () => {
    const shim = await freshShim()
    let disposed = 0
    const combined = new shim.Disposable(() => {
      disposed += 1
    })
    combined.dispose()
    assert.equal(disposed, 1)
    const emitter = new shim.EventEmitter()
    const seen: unknown[] = []
    const subscription = emitter.event((data) => {
      seen.push(data)
    })
    emitter.fire('a')
    subscription.dispose()
    emitter.fire('b')
    assert.deepEqual(seen, ['a'])
    const source = new shim.CancellationTokenSource()
    assert.equal(source.token.isCancellationRequested, false)
    source.cancel()
    assert.equal(source.token.isCancellationRequested, true)
  })

  it('validates positions, ranges, and relative patterns', async () => {
    const shim = await freshShim()
    assert.throws(() => new shim.Position(-1, 0), /not valid/)
    const range = new shim.Range(0, 0, 0, 5)
    assert.equal(range.contains(new shim.Position(0, 3)), true)
    // Patterns are data-only shapes here (containment applies at the
    // watcher/loader layer); only malformed shapes throw.
    const relative = new shim.RelativePattern('src', '**/*.ts')
    assert.equal(relative.pattern, '**/*.ts')
    assert.throws(() => new shim.RelativePattern(null, '**/*.ts'), /not valid/)
    assert.throws(() => new shim.RelativePattern('src', ''), /not valid/)
    const selection = new shim.Selection(0, 0, 1, 0)
    assert.ok(selection.anchor !== undefined)
  })
})

describe('vscode shim workspace configuration', () => {
  it('serves audited Prettier defaults with stored overrides and inspect', async () => {
    const shim = await freshShim()
    shim.__setExtensionSnapshots('a.b@1.0.0', { config: { 'prettier.tabWidth': 4 }, globalState: {}, workspaceState: {} })
    shim.__setActiveExtensionId('a.b@1.0.0')
    const config = shim.workspace.getConfiguration('prettier')
    assert.equal(config.get('tabWidth', 2), 4)
    assert.equal(config.get('printWidth', 0), 80)
    assert.equal(config.has('tabWidth'), true)
    assert.equal(config.has('missing'), false)
    assert.equal(config.inspect('tabWidth').defaultValue, 2)
    assert.equal(config.inspect('tabWidth').globalValue, 4)
    shim.__clearActiveExtensionId()
  })

  it('persists updates through main-owned write-through (never settings files)', async () => {
    const shim = await freshShim()
    const notified: { type: string; payload: unknown }[] = []
    shim.__setHostNotify((type, payload) => {
      notified.push({ type, payload })
    })
    shim.__setExtensionSnapshots('a.b@1.0.0', { config: {}, globalState: {}, workspaceState: {} })
    shim.__setActiveExtensionId('a.b@1.0.0')
    const config = shim.workspace.getConfiguration('eslint')
    await config.update('enable', true)
    assert.equal(config.get('enable', false), true)
    assert.ok(notified.some((entry) => entry.type === 'CONFIG_UPDATE'))
    await assert.rejects(config.update('', true), /not valid/)
    shim.__clearActiveExtensionId()
  })
})

describe('vscode shim window and commands', () => {
  it('shows messages via notify and resolves dismissed (no HTML)', async () => {
    const shim = await freshShim()
    const notified: { type: string; payload: unknown }[] = []
    shim.__setHostNotify((type, payload) => {
      notified.push({ type, payload })
    })
    shim.__setActiveExtensionId('a.b@1.0.0')
    assert.equal(await shim.window.showInformationMessage('hello', 'A', 'B'), undefined)
    assert.ok(notified.some((entry) => entry.type === 'MESSAGE_SHOWN'))
    shim.__clearActiveExtensionId()
  })

  it('routes quick picks and inputs through the host with safe fallbacks', async () => {
    const shim = await freshShim()
    // No handler: resolves undefined (dismissed), never hangs.
    assert.equal(await shim.window.showQuickPick(['a']), undefined)
    shim.__setHostRequestHandler(async (type) => {
      if (type === 'showQuickPick') {
        return { selected: 'a' }
      }
      if (type === 'showInputBox') {
        return { value: 'typed' }
      }
      return null
    })
    assert.equal(await shim.window.showQuickPick(['a', 'b']), 'a')
    assert.equal(await shim.window.showInputBox({ prompt: 'Name?' }), 'typed')
  })

  it('runs withProgress inline and bounds command nesting at 8', async () => {
    const shim = await freshShim()
    const result = await shim.window.withProgress({ title: 'T' }, async () => 'done')
    assert.equal(result, 'done')
    shim.__setActiveExtensionId('a.b@1.0.0')
    shim.commands.registerCommand('loop.a', async () => shim.commands.executeCommand('loop.a'))
    shim.__clearActiveExtensionId()
    await assert.rejects(shim.commands.executeCommand('loop.a'), /nesting/)
    shim.__resetForTests()
  })

  it('bounds output channels and normalizes status items', async () => {
    const shim = await freshShim()
    shim.__setActiveExtensionId('a.b@1.0.0')
    const channel = shim.window.createOutputChannel('ESLint')
    channel.append('line')
    channel.appendLine('line2')
    for (let index = 0; index < 15; index += 1) {
      shim.window.createOutputChannel(`channel-${index}`)
    }
    assert.throws(() => shim.window.createOutputChannel('overflow'), /Too many output channels/)
    const item = shim.window.createStatusBarItem(1)
    item.text = 'ESLint ✓'
    item.command = 'eslint.executeAutofix'
    item.show()
    assert.equal(item.text, 'ESLint ✓')
    assert.equal(item.command, 'eslint.executeAutofix')
    shim.__clearActiveExtensionId()
  })
})

describe('vscode shim storage, diagnostics, watchers, and edits', () => {
  it('reads/writes Memento synchronously with write-through notify', async () => {
    const shim = await freshShim()
    const notified: { type: string; payload: unknown }[] = []
    shim.__setHostNotify((type, payload) => {
      notified.push({ type, payload })
    })
    const memento = new shim.Memento('a.b@1.0.0', 'global', { existing: 1 })
    assert.equal(memento.get('existing'), 1)
    assert.equal(memento.get('missing', 'dflt'), 'dflt')
    assert.deepEqual(memento.keys(), ['existing'])
    await memento.update('k', 'v')
    assert.equal(memento.get('k'), 'v')
    await memento.update('k', undefined)
    assert.equal(memento.get('k'), undefined)
    assert.ok(notified.some((entry) => entry.type === 'STORAGE_WRITE'))
    await assert.rejects(memento.update('', 'x'), /not valid/)
  })

  it('collects bounded diagnostics with change notify', async () => {
    const shim = await freshShim()
    const notified: { type: string; payload: unknown }[] = []
    shim.__setHostNotify((type, payload) => {
      notified.push({ type, payload })
    })
    shim.__setActiveExtensionId('a.b@1.0.0')
    const collection = shim.languages.createDiagnosticCollection('eslint')
    const uri = shim.Uri.parse('file:/a.ts')
    collection.set(uri, [new shim.Diagnostic(new shim.Range(0, 0, 0, 5), 'oops', 0)])
    assert.equal(shim.__getAllDiagnostics().length, 1)
    collection.delete(uri)
    assert.equal(shim.__getAllDiagnostics().length, 0)
    assert.ok(notified.some((entry) => entry.type === 'DIAGNOSTICS_CHANGED'))
    shim.__clearActiveExtensionId()
  })

  it('registers bounded watchers and dispatches host events', async () => {
    const shim = await freshShim()
    shim.__setActiveExtensionId('a.b@1.0.0')
    const watcher = shim.workspace.createFileSystemWatcher('**/*.ts')
    const seen: unknown[] = []
    watcher.onDidChange((uri: unknown) => {
      seen.push(uri)
    })
    // Watcher ids start at 1 per fresh module state.
    shim.__dispatchWatcherEvent(1, 'change', 'file:/a.ts')
    assert.equal(seen.length, 1)
    assert.throws(() => shim.workspace.createFileSystemWatcher('/abs/*.ts'), /escapes/)
    watcher.dispose()
    shim.__clearActiveExtensionId()
  })

  it('queues WorkspaceEdit as review proposals (never disk writes)', async () => {
    const shim = await freshShim()
    const notified: { type: string; payload: unknown }[] = []
    shim.__setHostNotify((type, payload) => {
      notified.push({ type, payload })
    })
    shim.__setActiveExtensionId('a.b@1.0.0')
    const edit = new shim.WorkspaceEdit()
    edit.replace(shim.Uri.parse('file:/a.ts'), new shim.Range(0, 0, 0, 5), 'new')
    assert.equal(await shim.workspace.applyEdit(edit), true)
    assert.ok(notified.some((entry) => entry.type === 'EDIT_PROPOSAL'))
    await assert.rejects(shim.workspace.fs.writeFile(shim.Uri.parse('file:/a.ts'), new Uint8Array()), /Unsupported VS Code API/)
    shim.__clearActiveExtensionId()
  })

  it('marks terminal/debug namespaces honestly unsupported', async () => {
    const shim = await freshShim()
    assert.throws(() => shim.tasks.executeTask(), /Unsupported VS Code API/)
    assert.throws(() => shim.debug.startDebugging(), /Unsupported VS Code API/)
    assert.equal(shim.version, '1.90.0')
  })

  it('tracks workspace folders from main pushes with change events', async () => {
    const shim = await loadMjs<Shim & {
      __setWorkspaceFolders: (folders: { uri: string; name: string }[] | null) => void
      workspace: Shim['workspace'] & {
        workspaceFolders: { uri: { toString: () => string }; name: string }[] | undefined
        getWorkspaceFolder: (uri: unknown) => { name: string } | undefined
        onDidChangeWorkspaceFolders: (listener: (event: unknown) => void) => { dispose: () => void }
      }
    }>(SHIM_PATH)
    shim.__resetForTests()
    assert.equal(shim.workspace.workspaceFolders, undefined)
    assert.equal(shim.workspace.getWorkspaceFolder('file:/root/a.ts'), undefined)
    const seen: unknown[] = []
    shim.__setActiveExtensionId('a.b@1.0.0')
    shim.workspace.onDidChangeWorkspaceFolders((event) => {
      seen.push(event)
    })
    shim.__setWorkspaceFolders([{ uri: 'file:/root', name: 'root' }])
    const folders = shim.workspace.workspaceFolders as { uri: { toString: () => string }; name: string }[] | undefined
    assert.equal(folders?.length, 1)
    assert.equal(shim.workspace.getWorkspaceFolder('file:/root/a.ts')?.name, 'root')
    assert.equal(seen.length, 1)
    shim.__setWorkspaceFolders(null)
    assert.equal(shim.workspace.workspaceFolders, undefined)
    assert.equal(seen.length, 2)
    shim.__clearActiveExtensionId()
    shim.__resetForTests()
  })
})
