import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { InstalledExtensionEntry } from '../../shared/extension-registry/types'
import type { ExtensionRuntimeService } from '../extension-host/extension-runtime-service'
import { ExtensionAgentService } from './extension-agent-service'

function installedEntry(overrides = {}): InstalledExtensionEntry {
  return {
    namespace: 'example',
    name: 'agent',
    displayName: 'Example Agent',
    version: '1.0.0',
    status: 'installed',
    enabled: true,
    iconUrl: null,
    ...overrides
  }
}

function agentManifest(overrides = {}) {
  return {
    name: 'agent',
    publisher: 'example',
    version: '1.0.0',
    displayName: 'Example Agent',
    main: './out.js',
    activationEvents: ['onCommand:example.runAgent'],
    engines: { vscode: '^1.0.0' },
    contributes: {
      commands: [{ command: 'example.runAgent', title: 'Run agent' }],
      chatParticipants: [{ id: 'chat', name: 'Chat', fullName: 'Example Chat', command: 'example.runAgent' }]
    },
    ...overrides
  }
}

interface Harness {
  db: DatabaseSync
  service: ExtensionAgentService
  workspaces: WorkspaceRepository
  sessions: CodingSessionRepository
  workspaceId: number
  sessionId: number
  workRoot: string
  installRoot: string
  cleanup: () => void
}

function openService(options?: {
  readonly installed?: readonly InstalledExtensionEntry[]
  readonly manifests?: Readonly<Record<string, unknown>>
  readonly invoke?: (command: string, args: readonly unknown[]) => Promise<unknown>
}): Harness {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const transactions = new ChangeTransactionService(
    workspaces,
    new ChangeTransactionRepository(db),
    new WorkspaceFileWriteService(workspaces),
    () => 1000
  )
  const workRoot = mkdtempSync(join(tmpdir(), 'stark-agent-work-'))
  const installRoot = mkdtempSync(join(tmpdir(), 'stark-agent-install-'))
  const manifests = options?.manifests ?? { 'example.agent@1.0.0': agentManifest() }
  for (const [key, data] of Object.entries(manifests)) {
    const at = key.lastIndexOf('@')
    const coords = key.slice(0, at)
    const version = key.slice(at + 1)
    const dir = join(installRoot, coords as string, version as string, 'extension')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(data))
  }
  const installService = {
    listInstalled: async () => options?.installed ?? [installedEntry()]
  } as unknown as ExtensionInstallService
  const runtime = {
    invokeCommand: options?.invoke ?? (async () => ({ text: 'agent reply' }))
  } as unknown as ExtensionRuntimeService
  const service = new ExtensionAgentService({
    workspaces,
    sessions,
    files,
    transactions,
    installService,
    installRoot,
    runtime
  })
  return {
    db,
    service,
    workspaces,
    sessions,
    workspaceId: 0,
    sessionId: 0,
    workRoot,
    installRoot,
    cleanup: () => {
      rmSync(workRoot, { recursive: true, force: true })
      rmSync(installRoot, { recursive: true, force: true })
      db.close()
    }
  }
}

async function openSession(harness: Harness, content = 'Please refactor this'): Promise<void> {
  const workspace = harness.workspaces.create({ rootPath: harness.workRoot, displayName: 'work', now: 1000 })
  const sessionService = new CodingSessionService(harness.workspaces, harness.sessions)
  const session = await sessionService.createSession({ workspaceId: workspace.id })
  harness.sessions.appendMessage({ sessionId: session.id, role: 'user', content, now: 1001, retitle: null })
  harness.workspaceId = workspace.id
  harness.sessionId = session.id
}

function messageCount(harness: Harness): number {
  return harness.sessions.listMessagesNewestFirst(harness.sessionId, 50, null).length
}

describe('extension agent discovery (manifest-driven)', () => {
  it('lists eligible providers with their own icon and availability', async () => {
    const harness = openService({
      installed: [installedEntry({ iconUrl: 'data:image/png;base64,AAA' })]
    })
    try {
      const providers = await harness.service.listProviders()
      assert.equal(providers.length, 1)
      assert.equal(providers[0]?.extensionId, 'example.agent')
      assert.equal(providers[0]?.providerId, 'chat')
      assert.equal(providers[0]?.displayName, 'Example Chat')
      assert.equal(providers[0]?.iconUrl, 'data:image/png;base64,AAA')
      assert.equal(providers[0]?.availability.status, 'available')
      assert.deepEqual(providers[0]?.capabilities, { chat: true, streaming: false, tools: false, proposals: true, cancellation: false })
    } finally {
      harness.cleanup()
    }
  })

  it('non-agent extensions never appear (formatter manifest, no participants)', async () => {
    const harness = openService({
      installed: [installedEntry({ namespace: 'plain', name: 'formatter', displayName: 'Plain Formatter' })],
      manifests: {
        'plain.formatter@1.0.0': {
          name: 'formatter',
          publisher: 'plain',
          version: '1.0.0',
          main: './out.js',
          contributes: { commands: [{ command: 'plain.format', title: 'Format' }] }
        }
      }
    })
    try {
      assert.deepEqual(await harness.service.listProviders(), [])
    } finally {
      harness.cleanup()
    }
  })

  it('disabled extensions show unavailable with an honest reason (never executed)', async () => {
    const harness = openService({ installed: [installedEntry({ enabled: false })] })
    try {
      const providers = await harness.service.listProviders()
      assert.equal(providers.length, 1)
      assert.equal(providers[0]?.availability.status, 'unavailable')
      assert.equal(providers[0]?.availability.reason, 'Extension is disabled.')
    } finally {
      harness.cleanup()
    }
  })

  it('uninstalled extensions drop out on refresh', async () => {
    const harness = openService()
    try {
      assert.equal((await harness.service.listProviders()).length, 1)
      const empty = openService({ installed: [] })
      try {
        assert.deepEqual(await empty.service.listProviders(), [])
      } finally {
        empty.cleanup()
      }
    } finally {
      harness.cleanup()
    }
  })
})

describe('extension agent runs (bounded, review-gated)', () => {
  it('persists provider text in the same conversation', async () => {
    const seen: { command?: string; args?: readonly unknown[] } = {}
    const harness = openService({
      invoke: (async (command: string, args: readonly unknown[]) => {
        seen.command = command
        seen.args = args
        return { text: 'agent reply' }
      }) as (command: string, args: readonly unknown[]) => Promise<unknown>
    })
    try {
      await openSession(harness)
      const before = messageCount(harness)
      const outcome = await harness.service.runAgent({
        workspaceId: harness.workspaceId,
        sessionId: harness.sessionId,
        extensionId: 'example.agent',
        providerId: 'chat'
      })
      assert.equal(seen.command, 'example.runAgent')
      assert.equal((seen.args?.[0] as { prompt?: unknown })?.prompt, 'Please refactor this')
      assert.equal(outcome.message.role, 'assistant')
      assert.equal(outcome.message.content, 'agent reply')
      assert.equal(outcome.session.id, harness.sessionId)
      assert.deepEqual(outcome.proposalTransactionIds, [])
      assert.equal(messageCount(harness), before + 1)
    } finally {
      harness.cleanup()
    }
  })

  it('imports structured edits as pending transactions without touching disk', async () => {
    const harness = openService({
      invoke: async () => ({
        text: 'done',
        edits: [{ relativePath: 'notes.txt', proposedContent: 'updated notes\n' }]
      })
    })
    try {
      writeFileSync(join(harness.workRoot, 'notes.txt'), 'original notes\n')
      await openSession(harness)
      const outcome = await harness.service.runAgent({
        workspaceId: harness.workspaceId,
        sessionId: harness.sessionId,
        extensionId: 'example.agent',
        providerId: 'chat'
      })
      assert.equal(outcome.proposalTransactionIds.length, 1)
      // Human Accept is still required: disk bytes are untouched.
      assert.equal(readFileSync(join(harness.workRoot, 'notes.txt'), 'utf8'), 'original notes\n')
    } finally {
      harness.cleanup()
    }
  })

  it('refuses unknown providers and strict-shape violations (effort rejected)', async () => {
    const harness = openService()
    try {
      await openSession(harness)
      const base = { workspaceId: harness.workspaceId, sessionId: harness.sessionId, extensionId: 'example.agent', providerId: 'chat' }
      await assert.rejects(harness.service.runAgent({ ...base, extensionId: 'missing.ext' }), /compatible agent interface/)
      await assert.rejects(harness.service.runAgent({ ...base, providerId: 'missing' }), /compatible agent interface/)
      // STARK effort must never cross into extensions.
      await assert.rejects(harness.service.runAgent({ ...base, effort: 'high' } as unknown as Record<string, unknown>), /not valid/)
      await assert.rejects(harness.service.runAgent({ workspaceId: 1 }), /not valid/)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects unusable provider output with nothing persisted', async () => {
    const harness = openService({ invoke: async () => ({ text: '' }) })
    try {
      await openSession(harness)
      const before = messageCount(harness)
      await assert.rejects(
        harness.service.runAgent({
          workspaceId: harness.workspaceId,
          sessionId: harness.sessionId,
          extensionId: 'example.agent',
          providerId: 'chat'
        }),
        /unusable response/
      )
      assert.equal(messageCount(harness), before)
    } finally {
      harness.cleanup()
    }
  })

  it('rejects a second in-flight run for the same session', async () => {
    let release: (() => void) | null = null
    const harness = openService({
      invoke: () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({ text: 'slow reply' })
        })
    })
    try {
      await openSession(harness)
      const first = harness.service.runAgent({
        workspaceId: harness.workspaceId,
        sessionId: harness.sessionId,
        extensionId: 'example.agent',
        providerId: 'chat'
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      await assert.rejects(
        harness.service.runAgent({
          workspaceId: harness.workspaceId,
          sessionId: harness.sessionId,
          extensionId: 'example.agent',
          providerId: 'chat'
        })
      )
      const releaseRun = release as (() => void) | null
      releaseRun?.()
      const outcome = await first
      assert.equal(outcome.message.content, 'slow reply')
    } finally {
      harness.cleanup()
    }
  })

  it('never grants direct workspace-write authority (static boundary)', async () => {
    const raw = readFileSync(join(process.cwd(), 'src', 'main', 'extension-agents', 'extension-agent-service.ts'), 'utf8')
    // Code only (comments document the boundary in prose).
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    assert.ok(!code.includes('WorkspaceFileWriteService'), 'agent service must not reference the disk writer')
    assert.ok(!code.includes('workspaceFileWrite'), 'agent service must not reach any file writer')
    assert.ok(code.includes('createFileChange'), 'edits must flow through pending transactions')
  })
})
