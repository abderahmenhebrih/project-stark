import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CODE_OSS_COMPAT_PROPOSED_API,
  CODE_OSS_COMPAT_VERSION,
  classifyEngineRequirement,
  extensionApiCompatibility
} from './code-oss-compat'
import { analyzeCompatibility } from './extension-compat'
import { buildActivationIndex, extensionsForTrigger, parseActivationEvent } from './extension-activation-events'
import { normalizeManifestData } from './extension-manifest'
import { inspectExtensionLicense } from './extension-license'
import { capabilityForApi } from './extension-permissions'
import { classifyEditOrigin, requiresHumanAccept } from './extension-ai-safety'
import {
  __resetCompatDiagnosticsForTests,
  recentCompatDiagnostics,
  recordCompatDiagnostic
} from './extension-compat-report'
import { parseContributions } from './extension-contributions'
import { EXTENSION_HOST_MAX_RESTARTS, ExtensionHostManager } from './extension-host-manager'

const SHIM_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'vscode-shim.mjs')

async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

describe('code-oss compatibility contract', () => {
  it('pins one coherent version (never newer than supported)', () => {
    assert.equal(CODE_OSS_COMPAT_VERSION, '1.90.0')
    assert.equal(CODE_OSS_COMPAT_PROPOSED_API, false)
    assert.deepEqual(extensionApiCompatibility(), {
      vscodeVersion: '1.90.0',
      engineRange: '^1.90.0',
      proposedApi: false
    })
  })

  it('classifies engines.vscode honestly', () => {
    assert.equal(classifyEngineRequirement('^1.90.0').level, 'compatible')
    assert.equal(classifyEngineRequirement('^1.85.0').level, 'compatible')
    assert.equal(classifyEngineRequirement('*').level, 'likely-compatible')
    assert.equal(classifyEngineRequirement('^1.99.0').level, 'requires-newer-layer')
    assert.equal(classifyEngineRequirement('').level, 'unsupported')
    assert.equal(classifyEngineRequirement(null).level, 'unsupported')
  })

  it('reports engine/license detail through the compat analyzer without percentages', () => {
    const result = analyzeCompatibility({
      hasMain: true,
      hasBrowserOnly: false,
      contributesKeys: ['commands'],
      unsupportedApis: [],
      proposedApis: [],
      hasNativeModules: false,
      activationFailed: false,
      failureCode: null,
      engineDetail: 'engines.vscode ^1.99.0 requires a newer compatibility layer than 1.90.0.',
      licenseNotice: 'License may restrict use outside VS Code'
    })
    assert.equal(result.level, 'partial')
    assert.ok(result.reasons.every((reason) => !reason.includes('%')))
  })

  it('marks terminal/auth/tasks/scm partial and debuggers/notebooks unsupported', () => {
    for (const key of ['terminal', 'authentication', 'taskDefinitions', 'comments']) {
      const result = analyzeCompatibility({
        hasMain: true,
        hasBrowserOnly: false,
        contributesKeys: [key],
        unsupportedApis: [],
        proposedApis: [],
        hasNativeModules: false,
        activationFailed: false,
        failureCode: null
      })
      assert.equal(result.level, 'partial', key)
    }
    for (const key of ['debuggers', 'breakpoints', 'notebooks', 'fileSystemProviders']) {
      const result = analyzeCompatibility({
        hasMain: true,
        hasBrowserOnly: false,
        contributesKeys: [key],
        unsupportedApis: [],
        proposedApis: [],
        hasNativeModules: false,
        activationFailed: false,
        failureCode: null
      })
      assert.equal(result.level, 'unsupported', key)
    }
  })

  it('indexes the broad Code OSS activation set with star never auto-running', () => {
    const index = buildActivationIndex([
      { extensionId: 'x.view@1.0.0', activationEvents: ['onView:explorer', 'onUri', 'onFileSystem:memfs'] },
      { extensionId: 'x.debug@1.0.0', activationEvents: ['onDebug:node', 'onTaskType:npm', 'onNotebook:jupyter'] },
      { extensionId: 'x.auth@1.0.0', activationEvents: ['onAuthenticationRequest:github', 'onChatParticipant:helper'] },
      { extensionId: 'x.star@1.0.0', activationEvents: ['*'] }
    ])
    assert.deepEqual(extensionsForTrigger(index, 'byView', 'explorer'), ['x.view@1.0.0'])
    assert.deepEqual(extensionsForTrigger(index, 'byDebug', 'node'), ['x.debug@1.0.0'])
    assert.deepEqual(extensionsForTrigger(index, 'byTaskType', 'npm'), ['x.debug@1.0.0'])
    assert.deepEqual(extensionsForTrigger(index, 'byNotebook', 'jupyter'), ['x.debug@1.0.0'])
    assert.deepEqual(extensionsForTrigger(index, 'byAuthentication', 'github'), ['x.auth@1.0.0'])
    assert.deepEqual(extensionsForTrigger(index, 'byChatParticipant', 'helper'), ['x.auth@1.0.0'])
    assert.deepEqual(index.onUri, ['x.view@1.0.0'])
    assert.equal(parseActivationEvent('*').kind, 'star')
  })

  it('preserves broad manifest fields and license metadata without executing scripts', () => {
    const normalized = normalizeManifestData(
      {
        name: 'tool',
        publisher: 'vendor',
        version: '2.0.0',
        displayName: 'Tool',
        description: 'A tool',
        main: './out/extension.js',
        icon: 'images/icon.png',
        license: 'SEE LICENSE IN LICENSE.txt',
        keywords: ['ai', 'chat'],
        categories: ['AI', 'Other'],
        extensionPack: ['vendor.other'],
        extensionDependencies: ['vendor.base'],
        activationEvents: ['onCommand:tool.run'],
        engines: { vscode: '^1.90.0' },
        contributes: { commands: [{ command: 'tool.run', title: 'Run' }], unknownFuturePoint: [] },
        scripts: { postinstall: 'evil()' }
      },
      { namespace: 'vendor', name: 'tool', version: '2.0.0' }
    )
    assert.equal(normalized.description, 'A tool')
    assert.equal(normalized.icon, 'images/icon.png')
    assert.deepEqual([...normalized.keywords], ['ai', 'chat'])
    assert.deepEqual([...normalized.extensionPack], ['vendor.other'])
    assert.deepEqual([...normalized.extensionDependencies], ['vendor.base'])
    // Unknown contribution points are preserved for forward compat.
    assert.ok(normalized.contributes !== null && 'unknownFuturePoint' in normalized.contributes)
    assert.ok(!('scripts' in (normalized as unknown as Record<string, unknown>)))
  })

  it('flags obvious host-use license restrictions without legal interpretation', () => {
    const restricted = inspectExtensionLicense('For use with Microsoft Visual Studio Code only')
    assert.equal(restricted.restrictsAlternateHosts, true)
    assert.equal(restricted.notice, 'License may restrict use outside VS Code')
    const permissive = inspectExtensionLicense('MIT')
    assert.equal(permissive.restrictsAlternateHosts, false)
    assert.equal(permissive.notice, null)
  })

  it('gates dangerous capabilities without prompting for harmless APIs', () => {
    assert.equal(capabilityForApi('commands.registerCommand'), null)
    assert.equal(capabilityForApi('workspace.fs.readFile'), 'filesystem-outside-workspace')
    assert.equal(capabilityForApi('env.openExternal'), 'external-url')
    assert.equal(capabilityForApi('authentication.getSession'), 'secrets')
    assert.equal(capabilityForApi('window.createTerminal'), 'terminal')
    assert.equal(capabilityForApi('debug.startDebugging'), 'debug-execution')
  })

  it('keeps autonomous AI edits review-gated while user actions stay direct', () => {
    assert.equal(requiresHumanAccept({ origin: 'autonomous-agent', extensionId: 'a.b@1', editsCount: 3 }), true)
    assert.equal(requiresHumanAccept({ origin: 'user-action', extensionId: 'a.b@1', editsCount: 3 }), false)
    assert.equal(classifyEditOrigin('composer-agent'), 'autonomous-agent')
    assert.equal(classifyEditOrigin('command-palette'), 'user-action')
  })

  it('records local-only compat diagnostics without code, prompts, or secrets', () => {
    __resetCompatDiagnosticsForTests()
    recordCompatDiagnostic({
      extensionId: 'vendor.tool@2.0.0',
      version: '2.0.0',
      requestedApi: 'vscode.chat',
      unsupportedApi: 'vscode.chat',
      activationEvent: 'onCommand:tool.run',
      category: 'unsupported-api'
    })
    const [entry] = recentCompatDiagnostics()
    assert.equal(entry?.extensionId, 'vendor.tool@2.0.0')
    assert.equal(entry?.unsupportedApi, 'vscode.chat')
    assert.ok(!('code' in (entry as unknown as Record<string, unknown>)))
  })

  it('parses generic views contributions without executing them', () => {
    const parsed = parseContributions({
      views: { explorer: [{ id: 'x.tree', name: 'Tree' }] },
      viewsContainers: { activitybar: [{ id: 'x.side', title: 'Side', icon: 'i.svg' }] },
      debuggers: []
    })
    assert.equal(parsed.views.length, 1)
    assert.deepEqual(parsed.viewsContainers, ['x.side'])
    assert.deepEqual(parsed.otherKeys, ['debuggers'])
  })

  it('bounds host restarts (no infinite loop, STARK stays open)', () => {
    assert.equal(EXTENSION_HOST_MAX_RESTARTS, 3)
    const manager = new ExtensionHostManager({
      bootstrapPath: join(tmpdir(), 'missing-bootstrap.js'),
      userDataDir: mkdtempSync(join(tmpdir(), 'stark-host-restart-')),
      launcher: {
        fork(): never {
          throw new Error('no launcher in this test')
        }
      }
    })
    // Never started: restart is not available, and nothing crashes.
    assert.equal(manager.canRestart(), false)
  })
})

describe('broad vscode API surface', () => {
  it('exposes no Proxy catch-all and throws explicit compatibility errors', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(SHIM_PATH, 'utf8')
    assert.ok(!source.includes('new Proxy'), 'shim must not proxy unknown APIs')
    const shim = await loadMjs<{
      __resetForTests: () => void
      __setActiveExtensionId: (id: string) => void
      __clearActiveExtensionId: () => void
      __getObservedUnsupportedApis: (owner: string) => string[]
      languages: { match: () => void }
      chat: { createChatParticipant: (id: string, handler: () => void) => { dispose: () => void } }
      lm: { registerTool: (name: string, tool: { invoke: () => void }) => { dispose: () => void } }
    }>(SHIM_PATH)
    shim.__resetForTests()
    assert.throws(() => shim.languages.match(), /Unsupported VS Code API: languages\.match/)
    shim.__setActiveExtensionId('vendor.tool@2.0.0')
    shim.chat.createChatParticipant('helper', () => {})
    shim.lm.registerTool('read-file', { invoke: () => {} })
    assert.throws(() => shim.languages.match(), /Unsupported VS Code API/)
    assert.ok(shim.__getObservedUnsupportedApis('vendor.tool@2.0.0').includes('languages.match'))
    shim.__clearActiveExtensionId()
    shim.__resetForTests()
  })

  it('registers trees, webviews, terminals, tasks, scm, auth, and tests generically', async () => {
    const shim = await loadMjs<{
      __resetForTests: () => void
      __setActiveExtensionId: (id: string) => void
      __clearActiveExtensionId: () => void
      __getOwnerRegistrations: (owner: string) => Record<string, unknown>
      window: {
        createTreeView: (id: string, options: unknown) => { dispose: () => void }
        createTerminal: (options?: unknown) => { dispose: () => void }
        createWebviewPanel: (type: string, title: string, show: unknown, options?: unknown) => { dispose: () => void }
        registerTreeDataProvider: (id: string, provider: unknown) => { dispose: () => void }
      }
      tasks: { registerTaskProvider: (type: string, provider: unknown) => { dispose: () => void } }
      scm: { createSourceControl: (id: string, label: string) => { dispose: () => void } }
      tests: { createTestController: (id: string, label: string) => { dispose: () => void } }
      authentication: { onDidChangeSessions: (listener: () => void) => { dispose: () => void } }
      env: { appName: string; appHost: string }
      version: string
    }>(SHIM_PATH)
    shim.__resetForTests()
    const owner = 'vendor.tool@2.0.0'
    shim.__setActiveExtensionId(owner)
    shim.window.registerTreeDataProvider('x.tree', { getChildren: () => [] })
    shim.window.createTerminal({ name: 't' })
    shim.window.createWebviewPanel('x.view', 'Title', {}, { enableScripts: false })
    shim.tasks.registerTaskProvider('npm', { provideTasks: () => [] })
    shim.scm.createSourceControl('git', 'Git')
    shim.tests.createTestController('x.tests', 'Tests')
    shim.authentication.onDidChangeSessions(() => {})
    const summary = shim.__getOwnerRegistrations(owner) as { treeViews: number; taskProviders: number; terminals: number }
    assert.equal(summary.treeViews, 1)
    assert.equal(summary.taskProviders, 1)
    assert.equal(summary.terminals, 1)
    assert.equal(shim.env.appName, 'STARK')
    assert.equal(shim.env.appHost, 'desktop')
    assert.equal(shim.version, '1.90.0')
    shim.__clearActiveExtensionId()
    shim.__resetForTests()
  })

  it('keeps extension storage on main-owned snapshots with protected secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-codeoss-ctx-'))
    try {
      const host = await loadMjs<{
        handleExtensionMessage: (message: unknown, channel: unknown) => Promise<void>
        __resetForTests: () => void
      }>(join(process.cwd(), 'src', 'main', 'extension-host', 'generic-host.mjs'))
      host.__resetForTests()
      const entry = `
import { commands } from 'vscode';
export async function activate(context) {
  if (typeof context.secrets.get !== 'function') throw new Error('secrets.get missing');
  if (typeof context.secrets.store !== 'function') throw new Error('secrets.store missing');
  if (!context.storageUri) throw new Error('storageUri missing');
  if (!context.logUri) throw new Error('logUri missing');
  commands.registerCommand('vendor.ctx.ok', () => 1);
}
`
      const versionDir = join(root, 'vendor.tool', '2.0.0')
      mkdirSync(join(versionDir, 'extension', 'out'), { recursive: true })
      writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name: 'tool', publisher: 'vendor', version: '2.0.0', main: './out/entry.js' }))
      writeFileSync(join(versionDir, 'extension', 'out', 'entry.js'), entry)
      const posts: { type: string; payload: unknown }[] = []
      await host.handleExtensionMessage(
        { type: 'ACTIVATE_EXTENSION', payload: { activationId: 'a1', extensionId: 'vendor.tool@2.0.0', storeRoot: root, extensionDir: versionDir, manifest: {} } },
        { postMessage: (type: string, payload: unknown) => posts.push({ type, payload }) }
      )
      assert.equal(posts[posts.length - 1]?.type, 'EXTENSION_ACTIVATED')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
