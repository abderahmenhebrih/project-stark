import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { ExtensionHostManager } from '../extension-host/extension-host-manager'
import { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { FormatterError, toPublicFormatterError } from './errors'
import {
  applyFormatEdits,
  FORMATTER_ACTIVATION_TIMEOUT_MS,
  FORMATTER_REQUEST_TIMEOUT_MS,
  FormatterService,
  PILOT_FORMATTER_NAME,
  PILOT_FORMATTER_NAMESPACE,
  pilotLanguageIdForPath
} from './formatter-service'

/** Controllable host double: captures posts, replays parsed replies. */
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

function fakeInstall(overrides?: {
  resolve?: { extensionDir: string; version: string; displayName: string } | null
  installed?: { namespace: string; name: string; enabled: boolean }[]
}): { service: ExtensionInstallService; resolveCalls: unknown[][] } {
  const resolveCalls: unknown[][] = []
  const service = {
    resolveEnabledExtensionPackage: (namespace: string, name: string) => {
      resolveCalls.push([namespace, name])
      return overrides?.resolve ?? null
    },
    listInstalled: async () =>
      overrides?.installed ?? [{ namespace: 'esbenp', name: 'prettier-vscode', displayName: 'Prettier', version: '1.0.0', status: 'installed', enabled: true, iconUrl: null }]
  } as unknown as ExtensionInstallService
  return { service, resolveCalls }
}

function fakeFiles(content = 'const x=1\n', revision = 'rev-1'): { service: WorkspaceFilesService; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'stark-fmt-files-'))
  writeFileSync(join(root, 'a.js'), content)
  const service = {
    readTextFile: async () => ({ workspaceId: 7, relativePath: 'a.js', content, revision })
  } as unknown as WorkspaceFilesService
  return { service, root }
}

function fakeWorkspaces(root: string): WorkspaceRepository {
  return { findById: (id: number) => (id === 7 ? { id, rootPath: root, displayName: 'w', createdAt: 1, lastOpenedAt: 1 } : undefined) } as unknown as WorkspaceRepository
}

function openService(overrides?: {
  install?: Parameters<typeof fakeInstall>[0]
  content?: string
  requestTimeoutMs?: number
  activationTimeoutMs?: number
}): {
  service: FormatterService
  host: ReturnType<typeof fakeManager>
  install: ReturnType<typeof fakeInstall>
  files: ReturnType<typeof fakeFiles>
} {
  const host = fakeManager()
  const install = fakeInstall(overrides?.install)
  const files = fakeFiles(overrides?.content)
  const service = new FormatterService({
    manager: host.manager,
    installService: install.service,
    filesService: files.service,
    workspaces: fakeWorkspaces(files.root),
    formatterModuleUrl: 'file:///stark-test/formatter-host.mjs',
    requestTimeoutMs: overrides?.requestTimeoutMs,
    activationTimeoutMs: overrides?.activationTimeoutMs
  })
  return { service, host, install, files }
}

const PROTOCOL = 'stark-extension-host/v1'

describe('formatter pilot scope', () => {
  it('pins the exact Prettier identity and language gate', () => {
    assert.equal(PILOT_FORMATTER_NAMESPACE, 'esbenp')
    assert.equal(PILOT_FORMATTER_NAME, 'prettier-vscode')
    assert.equal(FORMATTER_REQUEST_TIMEOUT_MS, 15_000)
    assert.equal(FORMATTER_ACTIVATION_TIMEOUT_MS, 10_000)
    assert.equal(pilotLanguageIdForPath('src/a.ts'), 'typescript')
    assert.equal(pilotLanguageIdForPath('src/a.JS'), 'javascript')
    assert.equal(pilotLanguageIdForPath('a.json'), 'json')
    assert.equal(pilotLanguageIdForPath('a.md'), 'markdown')
    assert.equal(pilotLanguageIdForPath('a.py'), null)
    assert.equal(pilotLanguageIdForPath('Makefile'), null)
  })

  it('rejects malformed requests before any work', async () => {
    const { service, host } = openService()
    try {
      for (const bad of [null, 'x', [], {}, { workspaceId: 7 }, { workspaceId: 0, relativePath: 'a.js' }, { workspaceId: 7, relativePath: '' }, { workspaceId: 7, relativePath: 'a.js', extra: 1 }]) {
        await assert.rejects(service.formatDocument(bad), /not valid/)
      }
      assert.equal(host.startCalls, 0)
    } finally {
      service.dispose()
    }
  })

  it('asks only the allowlisted identity and never other enabled extensions', async () => {
    const { service, install, host } = openService({
      install: {
        resolve: null,
        installed: [
          { namespace: 'esbenp', name: 'prettier-vscode', enabled: true },
          { namespace: 'ms-python', name: 'python', enabled: true },
          { namespace: 'dbaeumer', name: 'vscode-eslint', enabled: true },
          { namespace: 'meta', name: 'pyrefly', enabled: true }
        ]
      }
    })
    try {
      // Prettier is listed but unresolvable (bad record): the only
      // resolution attempted is the pilot identity, then calm copy.
      await assert.rejects(service.formatDocument({ workspaceId: 7, relativePath: 'a.js' }), /Install Prettier/)
      assert.deepEqual(
        install.resolveCalls,
        [['esbenp', 'prettier-vscode']],
        'only the pilot identity may be resolved'
      )
      assert.equal(host.startCalls, 0, 'no host contact without the allowlisted package')
    } finally {
      service.dispose()
    }
  })

  it('rejects disabled Prettier without host contact', async () => {
    const { service, host } = openService({
      install: { resolve: null, installed: [{ namespace: 'esbenp', name: 'prettier-vscode', enabled: false }] }
    })
    try {
      await assert.rejects(service.formatDocument({ workspaceId: 7, relativePath: 'a.js' }), /Prettier is disabled/)
      assert.equal(host.startCalls, 0)
    } finally {
      service.dispose()
    }
  })

  it('rejects unsupported languages without host contact', async () => {
    const { service, host } = openService()
    try {
      await assert.rejects(service.formatDocument({ workspaceId: 7, relativePath: 'a.py' }), /No formatter is available/)
      assert.equal(host.startCalls, 0)
    } finally {
      service.dispose()
    }
  })
})

describe('formatter request lifecycle', () => {
  function readyService(content = 'const x=1\n'): ReturnType<typeof openService> & { pkg: { extensionDir: string; version: string; displayName: string } } {
    const opened = openService({
      install: { resolve: { extensionDir: '/store/esbenp.prettier-vscode/1.0.0/extension', version: '1.0.0', displayName: 'Prettier' } },
      content
    })
    return { ...opened, pkg: { extensionDir: '/store/esbenp.prettier-vscode/1.0.0/extension', version: '1.0.0', displayName: 'Prettier' } }
  }

  /** Polls for the latest post of a type (robust under suite load). */
  async function waitForPost(ctx: ReturnType<typeof openService>, type: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 2000
    for (;;) {
      const posts = ctx.host.posts.filter((p) => (p as { type: string }).type === type)
      if (posts.length > 0) {
        return posts[posts.length - 1] as Record<string, unknown>
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for host post ${type}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function waitForActivate(ctx: ReturnType<typeof openService>): Promise<string> {
    const posted = await waitForPost(ctx, 'ACTIVATE_FORMATTER')
    return (posted['payload'] as { activationId: string }).activationId
  }

  async function waitForFormatRequest(ctx: ReturnType<typeof openService>): Promise<string> {
    const posted = await waitForPost(ctx, 'FORMAT_DOCUMENT')
    return (posted['payload'] as { requestId: string }).requestId
  }

  /** Waits for a FORMAT post beyond the already-seen count (no stale ids). */
  async function waitForNewFormatRequest(ctx: ReturnType<typeof openService>, seenCount: number): Promise<string> {
    const deadline = Date.now() + 2000
    for (;;) {
      const posts = ctx.host.posts.filter((p) => (p as { type: string }).type === 'FORMAT_DOCUMENT')
      if (posts.length > seenCount) {
        return ((posts[posts.length - 1] as Record<string, unknown>)['payload'] as { requestId: string }).requestId
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for a new FORMAT_DOCUMENT post')
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  function replyReady(ctx: ReturnType<typeof openService>, activationId: string): void {
    ctx.host.emit({ protocol: PROTOCOL, type: 'FORMATTER_READY', payload: { activationId } })
  }

  it('starts the host on demand, activates once, and returns revision plus text', async () => {
    const ctx = readyService()
    try {
      const pending = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      assert.equal(ctx.host.startCalls, 0, 'host starts only when the first format needs it')
      const activationId = await waitForActivate(ctx)
      assert.equal(ctx.host.startCalls, 1)
      replyReady(ctx, activationId)
      const requestId = await waitForFormatRequest(ctx)
      const posted = ctx.host.posts[ctx.host.posts.length - 1] as { payload: Record<string, unknown> }
      assert.equal(posted.payload['filePath'], join(ctx.files.root, 'a.js'))
      assert.equal(posted.payload['languageId'], 'javascript')
      assert.equal(posted.payload['text'], 'const x=1\n')
      ctx.host.emit({ protocol: PROTOCOL, type: 'FORMAT_RESULT', payload: { requestId, edits: [] } })
      const result = await pending
      assert.deepEqual(result, { revision: 'rev-1', afterText: 'const x=1\n' })
      // A later document reuses the activation (exactly one ACTIVATE posted).
      const formatCount = ctx.host.posts.filter((p) => (p as { type: string }).type === 'FORMAT_DOCUMENT').length
      const second = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      const secondRequestId = await waitForNewFormatRequest(ctx, formatCount)
      assert.equal(ctx.host.posts.filter((p) => (p as { type: string }).type === 'ACTIVATE_FORMATTER').length, 1)
      ctx.host.emit({ protocol: PROTOCOL, type: 'FORMAT_RESULT', payload: { requestId: secondRequestId, edits: [] } })
      await second
    } finally {
      ctx.service.dispose()
    }
  })

  it('applies host edits in main and bounds the output', async () => {
    const ctx = readyService('const x={a:1}\n')
    try {
      const pending = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      replyReady(ctx, await waitForActivate(ctx))
      ctx.host.emit({
        protocol: PROTOCOL,
        type: 'FORMAT_RESULT',
        payload: {
          requestId: await waitForFormatRequest(ctx),
          edits: [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }, newText: ' = { a: 1 };' }]
        }
      })
      const result = await pending
      assert.equal(result.afterText, 'const x = { a: 1 };\n')
    } finally {
      ctx.service.dispose()
    }
  })

  it('refuses concurrent duplicates per document and times out without retries', async () => {
    const ctx = readyService()
    try {
      const first = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      await waitForActivate(ctx)
      await assert.rejects(ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' }), /already running/)
      replyReady(ctx, await waitForActivate(ctx))
      const requestId = await waitForFormatRequest(ctx)
      const formats = ctx.host.posts.filter((p) => (p as { type: string }).type === 'FORMAT_DOCUMENT').length
      assert.equal(formats, 1)
      ctx.host.emit({ protocol: PROTOCOL, type: 'FORMAT_RESULT', payload: { requestId, edits: [] } })
      await first
    } finally {
      ctx.service.dispose()
    }
  })

  it('times out a hung activation with no retry', async () => {
    const ctx = openService({
      requestTimeoutMs: 30,
      activationTimeoutMs: 30,
      install: { resolve: { extensionDir: '/store/x/extension', version: '1.0.0', displayName: 'P' } }
    })
    try {
      await assert.rejects(ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' }), /timed out/)
      const types = ctx.host.posts.map((p) => (p as { type: string }).type)
      assert.deepEqual(types, ['ACTIVATE_FORMATTER'])
    } finally {
      ctx.service.dispose()
    }
  })

  it('host crash fails the flight cleanly with no automatic restart', async () => {
    const ctx = readyService()
    try {
      const pending = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      replyReady(ctx, await waitForActivate(ctx))
      await waitForFormatRequest(ctx)
      const startsBefore = ctx.host.startCalls
      ctx.host.crash()
      await assert.rejects(pending, /No changes were made/)
      assert.equal(ctx.host.startCalls, startsBefore, 'a crash must never restart the host by itself')
    } finally {
      ctx.service.dispose()
    }
  })

  it('maps host error codes to calm copy without internals', async () => {
    const ctx = readyService()
    try {
      const pending = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      replyReady(ctx, await waitForActivate(ctx))
      const requestId = await waitForFormatRequest(ctx)
      ctx.host.emit({ protocol: PROTOCOL, type: 'FORMAT_ERROR', payload: { requestId, code: 'boom-secret-/tmp/x' } })
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Formatting failed. No changes were made.')
        assert.ok(!error.message.includes('/tmp'))
        return true
      })
    } finally {
      ctx.service.dispose()
    }
  })

  it('disable unloads best-effort: deactivate then stop, never throwing', async () => {
    const ctx = readyService()
    try {
      const pending = ctx.service.formatDocument({ workspaceId: 7, relativePath: 'a.js' })
      replyReady(ctx, await waitForActivate(ctx))
      const requestId = await waitForFormatRequest(ctx)
      ctx.host.emit({ protocol: PROTOCOL, type: 'FORMAT_RESULT', payload: { requestId, edits: [] } })
      await pending
      await ctx.service.noteExtensionDisabled()
      const types = ctx.host.posts.map((p) => (p as { type: string }).type)
      assert.ok(types.includes('DEACTIVATE_FORMATTER'))
      assert.equal(ctx.host.stopCalls, 1)
      await ctx.service.noteExtensionDisabled()
    } finally {
      ctx.service.dispose()
    }
  })
})

describe('applyFormatEdits (main-side, pure)', () => {
  it('applies sorted edits with CRLF-correct offsets', () => {
    assert.equal(
      applyFormatEdits('const x={a:1}\n', [
        { range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } }, newText: ' = { a: 1 };' }
      ]),
      'const x = { a: 1 };\n'
    )
    assert.equal(applyFormatEdits('ab\r\ncde\nf', [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'CDE' }]), 'ab\r\nCDE\nf')
    assert.equal(applyFormatEdits('same', []), 'same')
  })

  it('rejects overlapping, out-of-bounds, oversized, and excessive edits', () => {
    const overlapping = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: 'x' },
      { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } }, newText: 'y' }
    ]
    assert.throws(() => applyFormatEdits('0123456789', overlapping), FormatterError)
    assert.throws(
      () => applyFormatEdits('short', [{ range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }, newText: 'x' }]),
      FormatterError
    )
    assert.throws(
      () => applyFormatEdits('short', [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 1 } }, newText: 'x' }]),
      FormatterError
    )
    const tooMany = Array.from({ length: 65 }, () => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: ''
    }))
    assert.throws(() => applyFormatEdits('x', tooMany), FormatterError)
  })

  it('maps every code to safe copy', () => {
    assert.equal(toPublicFormatterError(new FormatterError('not_installed')).message, 'Install Prettier from Extensions to format this document.')
    assert.equal(toPublicFormatterError(new FormatterError('disabled')).message, 'Prettier is disabled.')
    assert.equal(toPublicFormatterError(new FormatterError('unsupported_language')).message, 'No formatter is available for this file.')
    assert.equal(toPublicFormatterError(new FormatterError('busy')).message, 'Formatting is already running for this file.')
    assert.equal(toPublicFormatterError({ nope: 1 }).message, 'Formatting failed. No changes were made.')
  })
})

describe('formatter static boundaries', () => {
  it('never reads extension code, writes project files, or touches secrets', () => {
    const service = readFileSync(join(process.cwd(), 'src', 'main', 'formatter', 'formatter-service.ts'), 'utf8')
    for (const forbidden of ['require(', 'readFileSync', 'writeFileSync', 'writeFile(', 'child_process', 'spawn(', 'exec(', 'shell:true', 'process.env', 'setInterval', 'eval(']) {
      assert.ok(!service.includes(forbidden), `formatter service must not contain ${forbidden}`)
    }
    assert.ok(!service.includes('executeExtension'), 'no generic extension execution entry may exist')
    assert.ok(service.includes('PILOT_FORMATTER_NAMESPACE'), 'activation must be allowlist-gated')
    const protocol = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'protocol.ts'), 'utf8')
    assert.ok(!protocol.includes('executeExtension'), 'protocol must not gain generic RPC')
    const host = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'formatter-host.mjs'), 'utf8')
    assert.ok(!host.includes('writeFile'), 'host formatter must never write files')
    assert.ok(!host.includes('shell:true'), 'host formatter must not spawn shells')
    assert.ok(host.includes('PILOT_FORMATTER_NAMESPACE'), 'host must enforce the same allowlist')
  })

  it('formatter module ships verbatim next to the bootstrap', () => {
    const script = readFileSync(join(process.cwd(), 'scripts', 'copy-extension-host-bootstrap.cjs'), 'utf8')
    for (const file of ['formatter-host.mjs', 'vscode-shim.mjs', 'vscode-loader.mjs']) {
      assert.ok(script.includes(file), `copy script must ship ${file}`)
    }
  })
})

describe('install-service pilot resolution', () => {
  function craftInstalled(root: string, namespace: string, name: string, version: string): void {
    const versionDir = join(root, `${namespace}.${name}`, version)
    mkdirSync(join(versionDir, 'extension'), { recursive: true })
    writeFileSync(join(versionDir, 'extension', 'package.json'), JSON.stringify({ name, publisher: namespace, version }))
    writeFileSync(
      join(versionDir, 'stark-install.json'),
      JSON.stringify({ namespace, name, displayName: name, version, sha256: '0'.repeat(64), installedAt: '2026-01-01T00:00:00.000Z', source: 'open-vsx' })
    )
  }

  function openInstallService(): { dir: string; service: ExtensionInstallService } {
    const dir = mkdtempSync(join(tmpdir(), 'stark-fmt-resolve-'))
    return { dir, service: new ExtensionInstallService(dir) }
  }

  it('resolves enabled installs, rejects disabled/absent/ghosts, picks highest semver', async () => {
    const { dir, service } = openInstallService()
    try {
      assert.equal(service.resolveEnabledExtensionPackage('esbenp', 'prettier-vscode'), null)
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '12.4.0')
      craftInstalled(dir, 'esbenp', 'prettier-vscode', '12.3.0')
      const resolved = service.resolveEnabledExtensionPackage('esbenp', 'prettier-vscode')
      assert.equal(resolved?.version, '12.4.0')
      assert.ok((resolved?.extensionDir ?? '').endsWith(join('esbenp.prettier-vscode', '12.4.0', 'extension')))
      assert.ok(!(resolved?.extensionDir ?? '').includes('..'))
      await service.setEnabled({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.4.0' }, false)
      assert.equal(service.resolveEnabledExtensionPackage('esbenp', 'prettier-vscode')?.version, '12.3.0')
      await service.setEnabled({ namespace: 'esbenp', name: 'prettier-vscode', version: '12.3.0' }, false)
      assert.equal(service.resolveEnabledExtensionPackage('esbenp', 'prettier-vscode'), null)
      assert.equal(service.resolveEnabledExtensionPackage('ms-python', 'python'), null)
      assert.equal(service.resolveEnabledExtensionPackage('../evil', 'x'), null)
      assert.equal(service.resolveEnabledExtensionPackage('esbenp', 'prettier-vscodeEXTRA'), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
