import assert from 'node:assert/strict'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations, getUserVersion } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter, ProviderWorkerTurnResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { ProviderTimeoutError } from '../ai/errors'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { WorkerToolRepository, hashToolArgs, hashState, serializeToolArgs } from '../worker-tools/worker-tool-repository'
import { WorkerCommandRepository } from '../worker-tools/worker-command-repository'
import { WorkerCommandService, type SpawnFn } from '../worker-tools/worker-command-service'
import { WorkerToolApprovalService } from '../worker-tools/worker-tool-approval-service'
import { WorkerReadToolService, parseWorkerToolRequest } from '../worker-tools/worker-tool-service'
import { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { capabilityForTool, workerToolSchemas, WORKER_TOOLS } from '../worker-tools/worker-tool-registry'
import { ToolInteractiveError } from '../worker-tools/worker-tool-errors'
import { ProjectRuntimeRepository } from './project-runtime-repository'
import { ProjectRuntimeService } from './project-runtime-service'
import {
  MAX_ACTIVE_RUNTIMES_PER_WORKSPACE,
  MAX_RECENT_RUNTIMES,
  MAX_RUNTIME_LOG_TAIL_BYTES,
  MAX_RUNTIME_PORT,
  MAX_RUNTIME_SESSION_MS,
  MAX_RUNTIME_STOP_WAIT_MS,
  MIN_RUNTIME_PORT
} from './project-runtime-limits'
import {
  buildAlreadyActivePayload,
  buildRuntimeApprovalSummary,
  parseRuntimeStartArgs,
  WORKER_RUNTIME_DENY_MESSAGE,
  WORKER_RUNTIME_INVALID_POLICY_MESSAGE,
  WORKER_RUNTIME_USER_DENY_MESSAGE
} from '../worker-tools/worker-runtime-validation'
import { buildTaskkillArgs, killProcessTree } from './process-tree'
import {
  buildPreviewWindowOptions,
  DENIED_PREVIEW_PERMISSIONS,
  isAllowedPreviewNavigation,
  isDeniedPreviewPermission,
  previewPartitionForRuntime,
  wirePreviewWindow,
  type PreviewWindow
} from './runtime-preview'
import { previewUrlForPort } from '../../shared/project-runtime/types'

class FakeProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake:${secret}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

class ScriptedAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: string[] = []
  planScript: (string | Error)[] = []
  turnScript: (ProviderWorkerTurnResult | Error)[] = []
  textScript: (string | Error)[] = []
  constructor(readonly id: ProviderId) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }
  async generateText(request: unknown): Promise<{ text: string }> {
    void request
    this.calls.push('text')
    const next = this.textScript.shift()
    if (next instanceof Error) throw next
    return { text: next as string }
  }
  async generateStructured(request: unknown): Promise<{ outputText: string }> {
    void request
    this.calls.push('structured')
    const next = this.planScript.shift()
    if (next instanceof Error) throw next
    return { outputText: next as string }
  }
  async generateWorkerTurn(request: unknown): Promise<ProviderWorkerTurnResult> {
    void request
    this.calls.push('turn')
    const next = this.turnScript.shift()
    if (next instanceof Error) throw next
    return next as ProviderWorkerTurnResult
  }
}

function delegatePlan(): string {
  return JSON.stringify({ action: 'delegate', planSummary: 'Needs work.', finalAnswer: null, workerInstruction: 'Inspect.', workerProfile: 'coding' })
}

interface Harness {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  workspaces: WorkspaceRepository
  codingRows: CodingSessionRepository
  runs: OrchestrationRepository
  sessions: CodingSessionService
  providerService: AiProviderService
  heart: HeartService
  looplinks: LooplinkRepository
  loopService: LooplinkService
  capService: CapabilityService
  gate: CapabilityGate
  tools: WorkerToolRepository
  runtimes: ProjectRuntimeRepository
  runtime: ProjectRuntimeService
  approvals: WorkerToolApprovalService
  executor: WorkerReadToolService
  runner: WorkerToolRunner
  txRows: ChangeTransactionRepository
  adapter: ScriptedAdapter
  guard: AiOperationGuard
  spawnCounter: { calls: number; kills: number }
}

function countingSpawn(counter: { calls: number; kills: number }): SpawnFn {
  return ((...args: Parameters<SpawnFn>): ChildProcess => {
    counter.calls += 1
    const child = (nodeSpawn as (...callArgs: unknown[]) => ChildProcess)(...args)
    const originalKill = child.kill.bind(child)
    child.kill = ((signal?: NodeJS.Signals): boolean => {
      counter.kills += 1
      return originalKill(signal)
    }) as typeof child.kill
    return child
  }) as SpawnFn
}

let nextTestPort = 51971
function testPort(): number {
  nextTestPort += 1
  return nextTestPort
}

function openHarness(options?: { lifetimeMs?: number; stopWaitMs?: number; logTailCapBytes?: number; logFlushMs?: number }): Harness {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const looplinks = new LooplinkRepository(db)
  const capStore = new CapabilityRepository(db)
  const tools = new WorkerToolRepository(db)
  const runtimes = new ProjectRuntimeRepository(db)
  const commandStore = new WorkerCommandRepository(db)
  const txRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-runtime-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new ScriptedAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const guard = new AiOperationGuard()
  const loopService = new LooplinkService(workspaces, codingRows, looplinks, guard, runs)
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const capService = new CapabilityService(capStore, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const approvals = new WorkerToolApprovalService(workspaces, codingRows, runs, tools)
  const writer = new WorkspaceFileWriteService(workspaces)
  const transactions = new ChangeTransactionService(workspaces, txRows, writer)
  const changeSets = new ChangeSetService(workspaces, setRows, txRows)
  const spawnCounter = { calls: 0, kills: 0 }
  const commandService = new WorkerCommandService({ workspaces, gate, commands: commandStore, spawnImpl: countingSpawn(spawnCounter) })
  const runtime = new ProjectRuntimeService({
    workspaces, gate, runtimes, runs,
    spawnImpl: countingSpawn(spawnCounter),
    lifetimeMs: options?.lifetimeMs,
    stopWaitMs: options?.stopWaitMs,
    logTailCapBytes: options?.logTailCapBytes,
    logFlushMs: options?.logFlushMs
  })
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets, commands: commandService, runtimes: runtime })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor, runtimes: runtime
  })
  return { db, dir, root, workspaceId, workspaces, codingRows, runs, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, runtimes, runtime, approvals, executor, runner, txRows, adapter, guard, spawnCounter }
}

async function closeHarness(h: Harness): Promise<void> {
  try {
    await h.runtime.shutdownAll(Date.now())
  } catch {
    // Best effort test cleanup.
  }
  await removeDirRobust(h.dir)
  h.db.close()
}

/**
 * Windows holds a removed directory's lock briefly after a child
 * process with that cwd dies. Retry boundedly so kills are verified
 * by row state, not by rmdir races.
 */
async function removeDirRobust(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') {
        throw error
      }
      await sleep(100)
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

async function seed(h: Harness): Promise<number> {
  await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
  h.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'model-B' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Start it.' })
  return session.id
}

function setPolicies(h: Harness, terminal: 'deny' | 'ask'): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'allow' },
      { capability: 'terminal.execute', mode: terminal },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

function createRun(h: Harness, sessionId: number): number {
  const messageId = h.codingRows.listMessagesNewestFirst(sessionId, 1, null)[0]?.id ?? 1
  return Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, messageId).lastInsertRowid)
}

function parkRuntime(h: Harness, sessionId: number, runId: number, program: string, args: string[], port: number): { approvalId: number; argsJson: string; argsHash: string; workspaceId: number; sessionId: number; runId: number } {
  const argsJson = serializeToolArgs({ program, args, port })
  const argsHash = hashToolArgs(argsJson)
  const messageId = h.codingRows.listMessagesNewestFirst(sessionId, 1, null)[0]?.id ?? 1
  const stateJson = JSON.stringify({ parked: true })
  const { approvalId } = h.tools.createApprovalAndPark({
    workspaceId: h.workspaceId, sessionId, runId, toolName: 'runtime_start', capability: 'terminal.execute',
    argsJson, argsHash, summary: `Start project runtime: ${program}`,
    state: { toolCallCount: 1, workerInstruction: 'x', activeUserMessageId: messageId, continuityUsed: false, stateJson, stateHash: hashState(stateJson) },
    now: Date.now()
  })
  return { approvalId, argsJson, argsHash, workspaceId: h.workspaceId, sessionId, runId }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('stage 26 registry, schema, and validation', () => {
  it('registry contains exactly eight tools with runtime mapping', () => {
    assert.deepEqual(
      [...WORKER_TOOLS].sort(),
      ['change_propose', 'git_read', 'preview_inspect', 'runtime_observe', 'runtime_start', 'terminal_execute', 'workspace_read', 'workspace_search'].sort()
    )
    assert.equal(capabilityForTool('runtime_start'), 'terminal.execute')
    assert.equal(workerToolSchemas().length, 8)
  })

  it('runtime schema is strict program plus argv plus port', () => {
    const schemas = workerToolSchemas()
    const runtime = schemas.find((s) => s.name === 'runtime_start')
    assert.ok(runtime !== undefined)
    const parameters = runtime.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
    assert.deepEqual([...parameters.required].sort(), ['args', 'port', 'program'])
    assert.equal(parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['args', 'port', 'program'])
    const text = JSON.stringify(runtime.parameters)
    for (const forbidden of ['"command"', '"cwd"', '"env"', '"host"', '"url"', '"protocol"', '"shell"', '"stdin"', '"timeout"', '"background"', '"detached"', '"workspaceId"', '"sessionId"']) {
      assert.ok(!text.includes(forbidden), `schema must not contain ${forbidden}`)
    }
  })

  it('parses valid runtime requests', () => {
    assert.deepEqual(parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run', 'dev'], port: 5173 }), {
      tool: 'runtime_start', program: 'npm', args: ['run', 'dev'], port: 5173
    })
    assert.deepEqual(parseRuntimeStartArgs({ program: 'node', args: [], port: 1024 }), { program: 'node', args: [], port: 1024 })
    assert.deepEqual(parseRuntimeStartArgs({ program: 'node', args: [], port: 65535 }), { program: 'node', args: [], port: 65535 })
  })

  it('rejects command strings, extra fields, and bad ports', () => {
    assert.throws(() => parseWorkerToolRequest('runtime_start', { command: 'npm run dev', port: 5173 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, cwd: '/tmp' }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, env: {} }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, host: '0.0.0.0' }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, url: 'http://x/' }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, shell: true }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173, background: true }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'] }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 0 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 80 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 1023 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 65536 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: 5173.5 }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: '5173' }))
    assert.throws(() => parseWorkerToolRequest('runtime_start', { program: 'npm', args: ['run'], port: -1 }))
  })

  it('reuses program and argv bounds exactly', () => {
    assert.throws(() => parseRuntimeStartArgs({ program: 'a/b', args: [], port: 5173 }))
    assert.throws(() => parseRuntimeStartArgs({ program: 'a:b', args: [], port: 5173 }))
    assert.throws(() => parseRuntimeStartArgs({ program: 'npm', args: Array.from({ length: 33 }, () => 'x'), port: 5173 }))
    assert.throws(() => parseRuntimeStartArgs({ program: 'npm', args: ['x'.repeat(2049)], port: 5173 }))
    assert.throws(() => parseRuntimeStartArgs({ program: 'npm', args: ['a\0b'], port: 5173 }))
    assert.doesNotThrow(() => parseRuntimeStartArgs({ program: 'npm', args: ['&&', '|', '>', '$(echo x)', '`echo x`'], port: 5173 }))
  })

  it('builds exact approval summaries with loopback preview', () => {
    const summary = buildRuntimeApprovalSummary({ program: 'npm', args: ['run', 'dev'], port: 5173 })
    assert.ok(summary.includes('Start project runtime: npm'))
    assert.ok(summary.includes('Program:'))
    assert.ok(summary.includes('[0] run'))
    assert.ok(summary.includes('[1] dev'))
    assert.ok(summary.includes('Preview: http://127.0.0.1:5173/'))
    assert.ok(summary.includes('Workspace root'))
    assert.ok(!/[A-Za-z]:\\/.test(summary), 'summary carries no host absolute path')
    assert.equal(previewUrlForPort(5173), 'http://127.0.0.1:5173/')
  })

  it('exposes one-active-runtime and copy constants', () => {
    assert.equal(MAX_ACTIVE_RUNTIMES_PER_WORKSPACE, 1)
    assert.equal(MAX_RUNTIME_SESSION_MS, 30 * 60 * 1000)
    assert.equal(MAX_RUNTIME_LOG_TAIL_BYTES, 128 * 1024)
    assert.equal(MIN_RUNTIME_PORT, 1024)
    assert.equal(MAX_RUNTIME_PORT, 65535)
    assert.equal(MAX_RUNTIME_STOP_WAIT_MS, 5000)
    assert.equal(MAX_RECENT_RUNTIMES, 10)
    const payload = buildAlreadyActivePayload({ id: 7, previewUrl: 'http://127.0.0.1:5173/', previewPort: 5173 })
    assert.deepEqual(JSON.parse(payload) as unknown, { status: 'runtime_already_active', runtimeId: 7, previewUrl: 'http://127.0.0.1:5173/', port: 5173 })
    assert.ok(WORKER_RUNTIME_DENY_MESSAGE.length > 0 && WORKER_RUNTIME_INVALID_POLICY_MESSAGE.length > 0 && WORKER_RUNTIME_USER_DENY_MESSAGE.length > 0)
  })
})

describe('stage 26 runtime repository', () => {
  it('schema is v18 with sessions table, UNIQUE approval, and workspace index', () => {
    const h = openHarness()
    try {
      assert.equal(getUserVersion(h.db), 18)
      const table: unknown = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_runtime_sessions'").get()
      assert.ok(table !== undefined)
      const index: unknown = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_runtime_workspace_created'").get()
      assert.ok(index !== undefined)
      const columns = h.db.prepare('PRAGMA table_info(project_runtime_sessions)').all() as { name: string }[]
      const names = columns.map((c) => c.name)
      assert.ok(!names.includes('pid'), 'no PID column')
      assert.ok(names.includes('approval_id') && names.includes('preview_port') && names.includes('stdout_tail'))
    } finally {
      void closeHarness(h)
    }
  })

  it('reserves at most once and consumes the approval atomically', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['a'], port)
      const { runtimeId } = h.runtimes.reserveStart({ approvalId: parked.approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, previewPort: port, now: 5 })
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'starting')
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'consumed')
      assert.throws(() => h.runtimes.reserveStart({ approvalId: parked.approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, previewPort: port, now: 6 }))
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 1)
    } finally {
      await closeHarness(h)
    }
  })

  it('reservation verifies hash, scope, pending state, and active conflict', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['a'], port)
      assert.throws(() => h.runtimes.reserveStart({ ...parked, program: 'node', argsHash: 'bad', previewPort: port, now: 5 }))
      assert.throws(() => h.runtimes.reserveStart({ ...parked, program: 'node', workspaceId: 999, previewPort: port, now: 5 }))
      assert.throws(() => h.runtimes.reserveStart({ ...parked, program: 'node', runId: 999, previewPort: port, now: 5 }))
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
      // An active runtime blocks a second reservation for another approval.
      const { runtimeId } = h.runtimes.reserveStart({ ...parked, program: 'node', previewPort: port, now: 5 })
      void runtimeId
      const second = parkRuntime(h, sessionId, runId, 'node', ['b'], port + 1)
      assert.throws(() => h.runtimes.reserveStart({ ...second, program: 'node', previewPort: port + 1, now: 6 }), /already active/)
      assert.equal(h.tools.findApproval(second.approvalId)?.status, 'pending')
    } finally {
      await closeHarness(h)
    }
  })

  it('transitions starting to running to terminal states exactly once', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['a'], port)
      const { runtimeId } = h.runtimes.reserveStart({ ...parked, program: 'node', previewPort: port, now: 5 })
      assert.equal(h.runtimes.markRunning(runtimeId, 6), true)
      assert.equal(h.runtimes.markRunning(runtimeId, 7), false)
      assert.equal(h.runtimes.finalizeSession(runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'user' }, 9), true)
      assert.equal(h.runtimes.finalizeSession(runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'user' }, 10), false)
      assert.equal(h.runtimes.findActiveForWorkspace(h.workspaceId), undefined)
    } finally {
      await closeHarness(h)
    }
  })

  it('startup marks starting and running interrupted with run ids', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const first = parkRuntime(h, sessionId, runId, 'node', ['a'], testPort())
      const one = h.runtimes.reserveStart({ ...first, program: 'node', previewPort: 51991, now: 5 })
      h.runtimes.markRunning(one.runtimeId, 6)
      // A second live row for the same run exercises the multi-row path
      // through a direct starting insert is impossible while active, so
      // finalize the first and reserve a running second row instead.
      h.runtimes.finalizeSession(one.runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'user' }, 7)
      const second = parkRuntime(h, sessionId, runId, 'node', ['b'], testPort())
      const two = h.runtimes.reserveStart({ ...second, program: 'node', previewPort: 51992, now: 8 })
      const outcome = h.runtimes.markStartingAndRunningAsInterrupted(99)
      assert.equal(outcome.interrupted, 1)
      assert.deepEqual(outcome.runIds, [runId])
      assert.equal(h.runtimes.findById(one.runtimeId)?.status, 'stopped')
      assert.equal(h.runtimes.findById(two.runtimeId)?.status, 'interrupted')
    } finally {
      await closeHarness(h)
    }
  })

  it('lists at most ten newest-first with workspace separation', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      for (let index = 0; index < 3; index += 1) {
        const parked = parkRuntime(h, sessionId, runId, 'node', [`job-${String(index)}`], testPort())
        const reserved = h.runtimes.reserveStart({ ...parked, program: 'node', previewPort: 52021 + index, now: 5 + index })
        h.runtimes.finalizeSession(reserved.runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'user' }, 9 + index)
      }
      const recent = h.runtimes.listRecentForWorkspace(h.workspaceId, MAX_RECENT_RUNTIMES)
      assert.equal(recent.length, 3)
      assert.ok((recent[0]?.createdAt ?? 0) >= (recent[2]?.createdAt ?? 0))
      assert.equal(h.runtimes.listRecentForWorkspace(9999, 10).length, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('enforces foreign keys and workspace cascade', () => {
    const h = openHarness()
    try {
      h.db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        h.db.exec("INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, preview_port, status, stdout_tail, stderr_tail, logs_truncated, total_output_bytes, created_at, updated_at) VALUES (999, 1, 1, 1, 'node', '[]', 'h', 5173, 'starting', '', '', 0, 0, 1, 1)")
      )
    } finally {
      void closeHarness(h)
    }
  })
})

describe('stage 26 runtime service', () => {
  it('starts a fixture server runtime with loopback preview identity', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', `require('http').createServer((q,s)=>s.end('fixture-ok')).listen(${String(port)},'127.0.0.1')`], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      assert.equal(outcome.previewUrl, `http://127.0.0.1:${String(port)}/`)
      assert.equal(outcome.port, port)
      assert.equal(h.spawnCounter.calls, 1)
      const row = h.runtimes.findById(outcome.runtimeId)
      assert.equal(row?.status, 'running')
      assert.ok((row?.startedAt ?? 0) >= 10)
      const active = h.runtime.getActiveSummary(h.workspaceId)
      assert.equal(active?.id, outcome.runtimeId)
      assert.equal(active?.previewUrl, `http://127.0.0.1:${String(port)}/`)
      // Runtime outlives the test's Work lifetime: still running here.
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
      assert.equal(h.runtimes.findById(outcome.runtimeId)?.status, 'stopped')
    } finally {
      await closeHarness(h)
    }
  })

  it('uses the trusted Workspace root as cwd without exposing it in headers', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'console.log(process.cwd());setInterval(()=>{},1000)'], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(900)
      const active = h.runtime.getActiveSummary(h.workspaceId)
      assert.equal(active?.status, 'running')
      assert.equal(active?.stdoutTail.trim(), await realpath(h.root))
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
    } finally {
      await closeHarness(h)
    }
  })

  it('sanitizes the environment of provider secrets', async () => {
    const h = openHarness()
    const previousKey = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'SECRET_TEST'
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', "console.log('key:'+(process.env.OPENAI_API_KEY||'absent'));setInterval(()=>{},1000)"], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(900)
      const active = h.runtime.getActiveSummary(h.workspaceId)
      assert.ok((active?.stdoutTail ?? '').includes('key:absent'))
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
    } finally {
      if (previousKey === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = previousKey
      }
      await closeHarness(h)
    }
  })

  it('closes stdin so interactive reads see EOF', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>{console.log('end:'+n);setInterval(()=>{},1000)})"], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(900)
      const active = h.runtime.getActiveSummary(h.workspaceId)
      assert.ok((active?.stdoutTail ?? '').includes('end:0'))
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
    } finally {
      await closeHarness(h)
    }
  })

  it('passes shell metacharacters as inert argv data', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const metachars = ['&&', '|', '>', '$(echo x)', '`echo x`']
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)));setInterval(()=>{},1000)', ...metachars], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(900)
      const active = h.runtime.getActiveSummary(h.workspaceId)
      assert.deepEqual(JSON.parse((active?.stdoutTail ?? '').trim()) as unknown, metachars)
      assert.equal(h.spawnCounter.calls, 1)
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
    } finally {
      await closeHarness(h)
    }
  })

  it('keeps rolling logs bounded while the runtime stays alive', async () => {
    const h = openHarness({ logTailCapBytes: 4096, logFlushMs: 500 })
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', "let i=0;setInterval(()=>{console.log(('MARK-'+(i++)).padEnd(256,'x'))},5)"], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(1200)
      // Large logs do NOT terminate the runtime.
      assert.equal(h.runtimes.findById(outcome.runtimeId)?.status, 'running')
      const active = h.runtime.getActiveSummary(h.workspaceId)
      if (active === null) throw new Error('runtime must be active')
      assert.ok(Buffer.byteLength(`${active.stdoutTail}${active.stderrTail}`, 'utf8') <= 4096)
      assert.equal(active.logsTruncated, true)
      assert.ok(active.totalOutputBytes > 4096)
      // Newest output retained, oldest dropped.
      const lastLine = (active.stdoutTail.trim().split('\n').pop() ?? '')
      assert.ok(/^MARK-\d+x*$/.test(lastLine))
      assert.ok(!active.stdoutTail.includes('MARK-0'))
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
    } finally {
      await closeHarness(h)
    }
  })

  it('records natural exits with no restart', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', "console.log('bye');process.exit(3)"], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(900)
      const row = h.runtimes.findById(outcome.runtimeId)
      assert.equal(row?.status, 'exited')
      assert.equal(row?.exitCode, 3)
      assert.equal(row?.stopReason, 'process_exit')
      assert.equal(h.spawnCounter.calls, 1)
      assert.equal(h.runtime.getActiveSummary(h.workspaceId), null)
    } finally {
      await closeHarness(h)
    }
  })

  it('user stop finalizes stopped/user and is idempotent', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parkedRuntime = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parkedRuntime.approvalId, argsJson: parkedRuntime.argsJson, argsHash: parkedRuntime.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      const stopped = await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
      assert.equal(stopped.status, 'stopped')
      assert.equal(stopped.stopReason, 'user')
      assert.equal(h.runtimes.findById(outcome.runtimeId)?.status, 'stopped')
      // Stopping again returns the terminal state without signalling.
      const killsBefore = h.spawnCounter.kills
      const again = await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 12 })
      assert.equal(again.status, 'stopped')
      assert.equal(h.spawnCounter.kills, killsBefore)
    } finally {
      await closeHarness(h)
    }
  })

  it('stop validates workspace ownership without signalling', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      const otherDir = mkdtempSync(join(tmpdir(), 'stark-runtime-other-'))
      const otherRoot = join(otherDir, 'project')
      mkdirSync(otherRoot, { recursive: true })
      const otherId = h.workspaces.create({ rootPath: otherRoot, displayName: 'other', now: 99 }).id
      await assert.rejects(h.runtime.stopRuntime({ workspaceId: otherId, runtimeId: outcome.runtimeId, now: 11 }))
      assert.equal(h.runtimes.findById(outcome.runtimeId)?.status, 'running')
      rmSync(otherDir, { recursive: true, force: true })
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 12 })
    } finally {
      await closeHarness(h)
    }
  })

  it('terminates spawned child trees on stop', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const heartbeat = join(h.root, 'heartbeat.txt')
      writeFileSync(heartbeat, '')
      // The grandchild is a fresh process: it requires its own modules
      // and receives the target path via argv (never parent locals).
      writeFileSync(
        join(h.root, 'grandchild-fixture.js'),
        `const fs = require('fs');\nsetInterval(() => { try { fs.appendFileSync(${JSON.stringify(heartbeat)}, 'b') } catch {} }, 50);\n`
      )
      const fixture =
        "const {spawn} = require('child_process');" +
        "const c = spawn(process.execPath, ['grandchild-fixture.js'], { stdio: 'ignore', detached: true });" +
        'c.unref();' +
        'setInterval(() => {}, 1000)'
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', fixture], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(700)
      assert.ok(readFileSync(heartbeat, 'utf8').length > 0, 'grandchild is alive before stop')
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: outcome.runtimeId, now: 11 })
      const sizeAtStop = readFileSync(heartbeat, 'utf8').length
      await sleep(600)
      assert.equal(readFileSync(heartbeat, 'utf8').length, sizeAtStop, 'grandchild tree stopped with the runtime')
    } finally {
      await closeHarness(h)
    }
  })

  it('enforces the hard lifetime with no restart', async () => {
    const h = openHarness({ lifetimeMs: 600 })
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'started')
      if (outcome.kind !== 'started') throw new Error('unreachable')
      await sleep(1100)
      const row = h.runtimes.findById(outcome.runtimeId)
      assert.equal(row?.status, 'timed_out')
      assert.equal(row?.stopReason, 'lifetime_limit')
      assert.equal(h.spawnCounter.calls, 1)
      assert.equal(h.runtime.getActiveSummary(h.workspaceId), null)
    } finally {
      await closeHarness(h)
    }
  })

  it('records spawn failures without retry', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'stark-definitely-missing-bin', ['--version'], port)
      const before = h.spawnCounter.calls
      // Resolution itself fails: no spawn attempted, row spawn_failed.
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'failed')
      assert.equal(h.spawnCounter.calls, before)
      assert.equal(h.runtimes.findByApproval(parked.approvalId)?.status, 'spawn_failed')
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'consumed')
    } finally {
      await closeHarness(h)
    }
  })

  it('returns the active runtime instead of reserving twice', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const first = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const started = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: first.approvalId, argsJson: first.argsJson, argsHash: first.argsHash, now: 10 })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') throw new Error('unreachable')
      const second = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port + 1)
      const outcome = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: second.approvalId, argsJson: second.argsJson, argsHash: second.argsHash, now: 11 })
      assert.equal(outcome.kind, 'active')
      if (outcome.kind !== 'active') throw new Error('unreachable')
      assert.equal(outcome.runtime.id, started.runtimeId)
      assert.equal(h.tools.findApproval(second.approvalId)?.status, 'pending')
      assert.equal(h.spawnCounter.calls, 1)
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: started.runtimeId, now: 12 })
    } finally {
      await closeHarness(h)
    }
  })

  it('rechecks the gate at start: deny and fake-allow never spawn', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['--version'], port)
      setPolicies(h, 'deny')
      const denied = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(denied.kind, 'denied')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.runtimes.findByApproval(parked.approvalId), undefined)
      h.db.exec("UPDATE workspace_capability_policies SET mode = 'allow' WHERE workspace_id = 1 AND capability = 'terminal.execute'")
      const parked2 = parkRuntime(h, sessionId, runId, 'node', ['--version'], port + 1)
      const invalid = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked2.approvalId, argsJson: parked2.argsJson, argsHash: parked2.argsHash, now: 10 })
      assert.equal(invalid.kind, 'denied')
      if (invalid.kind !== 'denied') throw new Error('unreachable')
      assert.equal(invalid.reason, WORKER_RUNTIME_INVALID_POLICY_MESSAGE)
      assert.equal(h.spawnCounter.calls, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('crash after reservation never starts: interrupted startup, consumed approval', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['--version'], port)
      const { runtimeId } = h.runtimes.reserveStart({ approvalId: parked.approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, previewPort: port, now: 10 })
      assert.equal(h.spawnCounter.calls, 0)
      const recovered = h.runtime.recoverAtStartup(99)
      assert.equal(recovered.interrupted, 1)
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'interrupted')
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'consumed')
      const run = h.runs.findRunById(runId)
      assert.equal(run?.status, 'failed')
      await assert.rejects(h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 100 }))
      assert.equal(h.spawnCounter.calls, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('shutdown stops live trees and finalizes app_shutdown', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const first = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], testPort())
      // One active runtime blocks the second reservation; stop the first via shutdown path instead.
      const started = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: first.approvalId, argsJson: first.argsJson, argsHash: first.argsHash, now: 10 })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') throw new Error('unreachable')
      const outcome = await h.runtime.shutdownAll(50)
      assert.equal(outcome.stopped, 1)
      const row = h.runtimes.findById(started.runtimeId)
      assert.equal(row?.status, 'stopped')
      assert.equal(row?.stopReason, 'app_shutdown')
    } finally {
      await closeHarness(h)
    }
  })

  it('late child events after shutdown and close never throw', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const started = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') throw new Error('unreachable')
      // Shut down, then close the database immediately: the killed
      // child's close event lands afterwards and must be a safe no-op,
      // never persistence on a closed handle (no uncaughtException).
      await h.runtime.shutdownAll(Date.now())
      h.db.close()
      await sleep(600)
      await removeDirRobust(h.dir)
    } catch (error) {
      try {
        h.db.close()
      } catch {
        // Already closed above by design.
      }
      throw error
    }
  })
})

describe('stage 26 worker approval flows', () => {
  it('deny policy hides the schema and denies forced requests', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'deny')
      const internals = h.runner as unknown as {
        advertisedTools: (workspaceId: number, sessionId: number) => { readonly name: string }[]
      }
      assert.ok(!internals.advertisedTools(h.workspaceId, sessionId).some((t) => t.name === 'runtime_start'))
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const terminal = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'runtime_start')
      assert.ok(terminal !== undefined && terminal.status === 'denied')
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
      assert.equal(h.spawnCounter.calls, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('ask parks with exact program, argv, and port, then starts once on approve', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const internals = h.runner as unknown as {
        advertisedTools: (workspaceId: number, sessionId: number) => { readonly name: string }[]
      }
      assert.ok(internals.advertisedTools(h.workspaceId, sessionId).some((t) => t.name === 'runtime_start'))
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'runtime_start')
      assert.ok(waiting.approval.summary.includes('Start project runtime: node'))
      assert.ok(waiting.approval.summary.includes(`http://127.0.0.1:${String(port)}/`))
      assert.ok(waiting.approval.summary.includes('Workspace root'))
      assert.ok(!waiting.approval.summary.includes(h.root))
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
      assert.equal(h.spawnCounter.calls, 0)
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.spawnCounter.calls, 1)
      const rows = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.status, 'running')
      runtimeId = rows[0]?.id ?? 0
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'consumed')
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      // The runtime outlives completed Work by design.
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'running')
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('human deny starts nothing and the Worker continues', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } },
        { kind: 'final_text', text: 'DONE-AFTER-DENY' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      assert.equal(resumed.result.message.content, 'FINAL')
      assert.equal(WORKER_RUNTIME_USER_DENY_MESSAGE, 'The user denied starting this runtime.')
    } finally {
      await closeHarness(h)
    }
  })

  it('tampered approval args never start', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET arguments_json = '{"args":["evil.js"],"port":5173,"program":"node"}' WHERE id = ${waiting.approval.id}`)
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('expired approvals start nothing with no provider continuation', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET created_at = ${Date.now() - 16 * 60 * 1000} WHERE id = ${waiting.approval.id}`)
      const callsBefore = h.adapter.calls.length
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }), /expired/i)
      assert.equal(h.adapter.calls.length, callsBefore)
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('policy revoke and master disable at approve time start nothing', async () => {
    for (const mutate of ['revoke', 'master'] as const) {
      const h = openHarness()
      try {
        const sessionId = await seed(h)
        setPolicies(h, 'ask')
        h.adapter.planScript = [delegatePlan()]
        h.adapter.turnScript = [
          { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } },
          { kind: 'final_text', text: 'DONE' }
        ]
        h.adapter.textScript = ['FINAL']
        const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
        assert.equal(waiting.kind, 'waiting_for_approval')
        if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
        if (mutate === 'revoke') {
          setPolicies(h, 'deny')
        } else {
          h.capService.updateConfig({
            workspaceId: h.workspaceId, enabled: false,
            policies: [
              { capability: 'workspace.read', mode: 'allow' },
              { capability: 'workspace.search', mode: 'deny' },
              { capability: 'git.read', mode: 'deny' },
              { capability: 'change.propose', mode: 'deny' },
              { capability: 'terminal.execute', mode: 'ask' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
            ]
          })
        }
        const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
        assert.equal(resumed.kind, 'completed')
        assert.equal(h.spawnCounter.calls, 0)
        assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
        const events = h.tools.listEvents(waiting.run.id)
        assert.ok(events.some((e) => e.toolName === 'runtime_start' && e.status === 'denied'))
      } finally {
        await closeHarness(h)
      }
    }
  })

  it('seeded persistent allow never starts and stays unadvertised', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.db.exec("UPDATE workspace_capability_policies SET mode = 'allow' WHERE workspace_id = 1 AND capability = 'terminal.execute'")
      const internals = h.runner as unknown as {
        advertisedTools: (workspaceId: number, sessionId: number) => { readonly name: string }[]
      }
      assert.ok(!internals.advertisedTools(h.workspaceId, sessionId).some((t) => t.name === 'runtime_start'))
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['--version'], port: testPort() } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const terminal = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'runtime_start')
      assert.ok(terminal !== undefined && terminal.status === 'denied')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('second start while active answers already-active with no new approval', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
      assert.notEqual(runtimeId, 0)
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'Start another.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: port + 1 } },
        { kind: 'final_text', text: 'DONE2' }
      ]
      h.adapter.textScript = ['FINAL2']
      const second = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(second.kind, 'completed')
      if (second.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(second.result.run.id)
      const start = events.find((e) => e.toolName === 'runtime_start')
      assert.ok(start !== undefined && start.status === 'succeeded')
      assert.deepEqual(JSON.parse(start.payload) as unknown, {
        status: 'runtime_already_active',
        runtimeId,
        previewUrl: `http://127.0.0.1:${String(port)}/`,
        port
      })
      assert.equal(h.spawnCounter.calls, 1)
      assert.equal(h.runtimes.listRecentForWorkspace(h.workspaceId, 10).length, 1)
      // After an explicit human stop, a fresh request parks again.
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'Start again.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: port + 1 } },
        { kind: 'final_text', text: 'DONE3' }
      ]
      h.adapter.textScript = ['FINAL3']
      const third = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(third.kind, 'waiting_for_approval')
      if (third.kind !== 'waiting_for_approval') throw new Error('unreachable')
      runtimeId = 0
      await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: third.approval.id })
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('run details carry the started runtime identity without secrets', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(resumed.result.run.id)
      const start = events.find((e) => e.toolName === 'runtime_start')
      assert.ok(start !== undefined && start.status === 'succeeded')
      const payload = JSON.parse(start.payload) as { status: string; runtimeId: number; previewUrl: string; port: number }
      assert.equal(payload.status, 'runtime_started')
      assert.equal(payload.previewUrl, `http://127.0.0.1:${String(port)}/`)
      assert.equal(payload.port, port)
      assert.ok(!start.payload.includes(h.root))
      runtimeId = payload.runtimeId
      const steps = h.runs.findSteps(resumed.result.run.id)
      assert.ok(steps.some((s) => (s.output ?? '').includes('Start project runtime: node')))
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })
})

describe('stage 26 bounds, recovery, and interactions', () => {
  it('runtime_start counts toward the four-tool budget', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'allow' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'allow' },
          { capability: 'terminal.execute', mode: 'ask' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } },
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'const' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 2\n' }] } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } }
      ]
      // The runtime approval parks the run at three tool calls; approve it,
      // then drive the remaining budget to the limit. Post-approval limit
      // breaches surface as tool-interactive run failures with no fifth
      // execution.
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'const' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 2\n' }] } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } }
      ]
      h.adapter.textScript = ['FINAL']
      const error = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(error instanceof ToolInteractiveError)
      assert.ok(h.adapter.calls.length <= 7)
      const events = h.tools.listEvents(waiting.run.id)
      assert.equal(events.length, 4)
      assert.equal(h.spawnCounter.calls, 1)
      const rows = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)
      runtimeId = rows[0]?.id ?? 0
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('approved runtime plus synthesis stays within seven provider calls', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.ok(h.adapter.calls.length <= 7)
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('approved runtime route survives Heart changes mid-wait', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: testPort() } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: { providerId: 'openai', model: 'model-C' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      for (const step of resumed.result.run.steps) {
        if (step.kind === 'worker' || step.kind === 'worker_followup') {
          assert.equal(step.modelAudit?.model, 'model-B')
        }
      }
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('runtime start then provider failure disables recovery but keeps the runtime', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: testPort() } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = [new ProviderTimeoutError()]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const error = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(error instanceof ToolInteractiveError)
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
      assert.notEqual(runtimeId, 0)
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'running')
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('looplink stays pending while waiting and consumes on success', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const created = await h.loopService.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: sessionId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, content: 'Continue it.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: testPort() } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: created.targetSession.id })
      assert.equal(waiting.kind, 'waiting_for_approval')
      assert.equal(h.looplinks.findByTargetSession(created.targetSession.id)?.status, 'pending')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.looplinks.findByTargetSession(created.targetSession.id)?.status, 'consumed')
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('runtime side effects stale later proposals without auto-accept', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'allow' },
          { capability: 'terminal.execute', mode: 'ask' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      const port = testPort()
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'runtime_start', args: { program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      // A concurrent external mutation lands while the runtime approval is
      // pending — exactly what a side-effecting runtime does to a file the
      // Worker read earlier. Deterministic: no spawn/propose race.
      writeFileSync(join(h.root, 'a.ts'), 'const a = 99\n')
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'stale try', proposedContent: 'const a = 2\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 99\n')
      const events = h.tools.listEvents(resumed.result.run.id)
      const propose = events.find((e) => e.toolName === 'change_propose')
      assert.ok(propose !== undefined && propose.status === 'failed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      runtimeId = h.runtimes.listRecentForWorkspace(h.workspaceId, 10)[0]?.id ?? 0
      assert.notEqual(runtimeId, 0)
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'running')
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('workspaces own isolated runtimes with per-workspace active limits', async () => {
    const h = openHarness()
    let firstId: number | undefined
    let secondId: number | undefined
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const otherDir = mkdtempSync(join(tmpdir(), 'stark-runtime-ws-'))
      const otherRoot = join(otherDir, 'project')
      mkdirSync(otherRoot, { recursive: true })
      const otherWorkspace = h.workspaces.create({ rootPath: otherRoot, displayName: 'other', now: 99 }).id
      h.capService.updateConfig({
        workspaceId: otherWorkspace, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'ask' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      const otherSession = (await h.sessions.createSession({ workspaceId: otherWorkspace })).id
      await h.sessions.sendUserMessage({ workspaceId: otherWorkspace, sessionId: otherSession, content: 'Start it.' })
      const runA = createRun(h, sessionId)
      const runB = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(otherWorkspace, otherSession, 1).lastInsertRowid)
      const parkedA = parkRuntime(h, sessionId, runA, 'node', ['-e', 'setInterval(()=>{},1000)'], testPort())
      // parkRuntime targets h.workspaceId; build the second approval manually.
      const argsJson = serializeToolArgs({ program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], port: testPort() })
      const messageId = h.codingRows.listMessagesNewestFirst(otherSession, 1, null)[0]?.id ?? 1
      const stateJson = JSON.stringify({ parked: true })
      const { approvalId } = h.tools.createApprovalAndPark({
        workspaceId: otherWorkspace, sessionId: otherSession, runId: runB, toolName: 'runtime_start', capability: 'terminal.execute',
        argsJson, argsHash: hashToolArgs(argsJson), summary: 'Start project runtime: node',
        state: { toolCallCount: 1, workerInstruction: 'x', activeUserMessageId: messageId, continuityUsed: false, stateJson, stateHash: hashState(stateJson) },
        now: Date.now()
      })
      const first = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId: runA, approvalId: parkedA.approvalId, argsJson: parkedA.argsJson, argsHash: parkedA.argsHash, now: 10 })
      const second = await h.runtime.executeApprovedRuntime({ workspaceId: otherWorkspace, sessionId: otherSession, runId: runB, approvalId, argsJson, argsHash: hashToolArgs(argsJson), now: 11 })
      assert.equal(first.kind, 'started')
      assert.equal(second.kind, 'started')
      if (first.kind !== 'started' || second.kind !== 'started') throw new Error('unreachable')
      firstId = first.runtimeId
      secondId = second.runtimeId
      assert.equal(h.runtime.getActiveSummary(h.workspaceId)?.id, firstId)
      assert.equal(h.runtime.getActiveSummary(otherWorkspace)?.id, secondId)
      await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId: firstId, now: Date.now() })
      await h.runtime.stopRuntime({ workspaceId: otherWorkspace, runtimeId: secondId, now: Date.now() })
      rmSync(otherDir, { recursive: true, force: true })
    } finally {
      await closeHarness(h)
    }
  })
})

describe('stage 26 preview security', () => {
  it('derives loopback-only preview URLs from ports', () => {
    assert.equal(previewUrlForPort(5173), 'http://127.0.0.1:5173/')
    assert.equal(previewUrlForPort(1024), 'http://127.0.0.1:1024/')
    assert.equal(previewUrlForPort(65535), 'http://127.0.0.1:65535/')
  })

  it('allows same loopback origin paths and blocks everything else', () => {
    assert.equal(isAllowedPreviewNavigation('http://127.0.0.1:5173/', 5173), true)
    assert.equal(isAllowedPreviewNavigation('http://127.0.0.1:5173/app?x=1#y', 5173), true)
    assert.equal(isAllowedPreviewNavigation('http://example.com/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('https://example.com/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://127.0.0.1:5174/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://localhost:5173/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://192.168.1.10:5173/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://10.0.0.5:5173/', 5173), false)
    assert.equal(isAllowedPreviewNavigation('file:///etc/passwd', 5173), false)
    assert.equal(isAllowedPreviewNavigation('javascript:alert(1)', 5173), false)
    assert.equal(isAllowedPreviewNavigation('data:text/html,hi', 5173), false)
    assert.equal(isAllowedPreviewNavigation('stark://preview', 5173), false)
    assert.equal(isAllowedPreviewNavigation('not a url', 5173), false)
    assert.equal(isAllowedPreviewNavigation('http://127.0.0.1:5173/', 80), false)
    assert.equal(isAllowedPreviewNavigation('https://127.0.0.1:5173/', 5173), false)
  })

  it('denies sensitive permissions and hardens window options', () => {
    for (const permission of ['camera', 'microphone', 'geolocation', 'notifications', 'midi', 'serial', 'usb', 'bluetooth']) {
      assert.equal(isDeniedPreviewPermission(permission), true)
    }
    assert.ok(DENIED_PREVIEW_PERMISSIONS.length >= 8)
    const options = buildPreviewWindowOptions(42)
    const prefs = options.webPreferences ?? {}
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.webSecurity, true)
    assert.ok(typeof prefs.partition === 'string' && prefs.partition.includes('42'))
    assert.ok(!('preload' in prefs), 'no STARK preload in preview windows')
    assert.equal(previewPartitionForRuntime(42), previewPartitionForRuntime(42))
    assert.ok(previewPartitionForRuntime(42) !== previewPartitionForRuntime(43))
  })

  it('wires popups, navigation, permissions, and close on preview windows', () => {
    const opened: { action: string }[] = []
    const prevented: string[] = []
    const permissions: { permission: string; granted: boolean }[] = []
    const shown: boolean[] = []
    let closed = false
    const closedListeners: (() => void)[] = []
    const readyListeners: (() => void)[] = []
    const fake = {
      webContents: {
        on(event: 'will-navigate', listener: (details: { url: string; preventDefault: () => void }) => void): void {
          if (event === 'will-navigate') {
            listener({ url: 'http://127.0.0.1:5173/app', preventDefault: () => undefined })
            listener({
              url: 'http://example.com/',
              preventDefault: () => {
                prevented.push('http://example.com/')
              }
            })
          }
        },
        setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void {
          opened.push(handler({ url: 'http://example.com/' }))
        },
        setPermissionRequestHandler(handler: (permission: string, decide: (granted: boolean) => void) => void): void {
          for (const permission of ['camera', 'geolocation']) {
            handler(permission, (granted) => {
              permissions.push({ permission, granted })
            })
          }
        },
        loadURL(url: string): Promise<void> {
          void url
          return Promise.resolve()
        },
        reload(): void {}
      },
      on(event: 'closed' | 'ready-to-show', listener: () => void): void {
        if (event === 'closed') {
          closedListeners.push(listener)
        } else {
          readyListeners.push(listener)
        }
      },
      show(): void {
        shown.push(true)
      },
      isDestroyed(): boolean {
        return false
      }
    } satisfies PreviewWindow
    wirePreviewWindow(fake, 5173, () => {
      closed = true
    })
    assert.deepEqual(opened, [{ action: 'deny' }])
    assert.deepEqual(prevented, ['http://example.com/'])
    assert.deepEqual(permissions, [
      { permission: 'camera', granted: false },
      { permission: 'geolocation', granted: false }
    ])
    for (const listener of readyListeners) {
      listener()
    }
    assert.deepEqual(shown, [true])
    for (const listener of closedListeners) {
      listener()
    }
    assert.equal(closed, true)
  })

  it('opens previews only for running runtimes with main-derived URLs', async () => {
    const h = openHarness()
    let runtimeId = 0
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      // openPreview with no window factory and non-running rows is rejected.
      await assert.rejects(h.runtime.openPreview({ workspaceId: h.workspaceId, runtimeId: 999 }))
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const started = await h.runtime.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') throw new Error('unreachable')
      runtimeId = started.runtimeId
      // Renderer cannot submit URLs: unknown ids and foreign workspaces reject.
      await assert.rejects(h.runtime.openPreview({ workspaceId: h.workspaceId, runtimeId: 99999 }))
      const otherDir = mkdtempSync(join(tmpdir(), 'stark-runtime-prev-'))
      const otherRoot = join(otherDir, 'project')
      mkdirSync(otherRoot, { recursive: true })
      const otherWorkspace = h.workspaces.create({ rootPath: otherRoot, displayName: 'other', now: 99 }).id
      await assert.rejects(h.runtime.openPreview({ workspaceId: otherWorkspace, runtimeId }))
      // No preview factory in this harness: opening reports unavailable, runtime untouched.
      await assert.rejects(h.runtime.openPreview({ workspaceId: h.workspaceId, runtimeId }))
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'running')
      rmSync(otherDir, { recursive: true, force: true })
    } finally {
      if (runtimeId !== 0) {
        try {
          await h.runtime.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('opens and reloads previews through an injected window factory', async () => {
    const h = openHarness()
    let runtimeId = 0
    let previewService: ProjectRuntimeService | undefined
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const loads: string[] = []
      let reloads = 0
      const opened: { action: string }[] = []
      const permissions: { permission: string; granted: boolean }[] = []
      let destroyed = false
      const closedListeners: (() => void)[] = []
      const fakeWindow = {
        webContents: {
          on(event: 'will-navigate', listener: (details: { url: string; preventDefault: () => void }) => void): void {
            void event
            void listener
          },
          setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void {
            opened.push(handler({ url: 'http://example.com/' }))
          },
          setPermissionRequestHandler(handler: (permission: string, decide: (granted: boolean) => void) => void): void {
            handler('camera', (granted) => {
              permissions.push({ permission: 'camera', granted })
            })
          },
          loadURL(url: string): Promise<void> {
            loads.push(url)
            return Promise.resolve()
          },
          reload(): void {
            reloads += 1
          }
        },
        on(event: 'closed' | 'ready-to-show', listener: () => void): void {
          if (event === 'closed') {
            closedListeners.push(listener)
          }
        },
        show(): void {},
        isDestroyed(): boolean {
          return destroyed
        }
      } satisfies PreviewWindow
      previewService = new ProjectRuntimeService({
        workspaces: h.workspaces,
        gate: h.gate,
        runtimes: h.runtimes,
        runs: h.runs,
        spawnImpl: countingSpawn(h.spawnCounter),
        createPreviewWindow: () => fakeWindow
      })
      const runId = createRun(h, sessionId)
      const port = testPort()
      const parked = parkRuntime(h, sessionId, runId, 'node', ['-e', 'setInterval(()=>{},1000)'], port)
      const started = await previewService.executeApprovedRuntime({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') throw new Error('unreachable')
      runtimeId = started.runtimeId
      const openedSummary = await previewService.openPreview({ workspaceId: h.workspaceId, runtimeId })
      assert.equal(openedSummary.id, runtimeId)
      // Renderer cannot submit URLs: main derived the exact loopback origin.
      assert.deepEqual(loads, [`http://127.0.0.1:${String(port)}/`])
      assert.deepEqual(opened, [{ action: 'deny' }])
      assert.deepEqual(permissions, [{ permission: 'camera', granted: false }])
      // Opening again while the window lives reuses it without a second load.
      await previewService.openPreview({ workspaceId: h.workspaceId, runtimeId })
      assert.equal(loads.length, 1)
      await previewService.reloadPreview({ workspaceId: h.workspaceId, runtimeId })
      assert.equal(reloads, 1)
      // Closing the preview drops the reference; the runtime keeps running.
      for (const listener of closedListeners) {
        listener()
      }
      destroyed = true
      await assert.rejects(previewService.reloadPreview({ workspaceId: h.workspaceId, runtimeId }))
      assert.equal(h.runtimes.findById(runtimeId)?.status, 'running')
    } finally {
      if (runtimeId !== 0 && previewService !== undefined) {
        try {
          await previewService.stopRuntime({ workspaceId: h.workspaceId, runtimeId, now: Date.now() })
        } catch {
          // Best effort test cleanup.
        }
      }
      await closeHarness(h)
    }
  })

  it('terminates exact process trees and nothing else', () => {
    assert.deepEqual(buildTaskkillArgs(1234), ['/PID', '1234', '/T', '/F'])
    assert.throws(() => buildTaskkillArgs(0))
    assert.throws(() => buildTaskkillArgs(-5))
    assert.throws(() => buildTaskkillArgs(1.5))
    const killed: { pid: number; signal: NodeJS.Signals }[] = []
    const signals: NodeJS.Signals[] = []
    killProcessTree(
      { pid: 4321, kill: ((signal?: NodeJS.Signals): boolean => { signals.push(signal ?? 'SIGTERM'); return true }) as ChildProcess['kill'] },
      {
        platform: 'linux',
        processKill: (pid, signal) => {
          killed.push({ pid, signal })
        }
      }
    )
    assert.deepEqual(killed, [{ pid: -4321, signal: 'SIGTERM' }])
    assert.deepEqual(signals, [])
    const spawned: unknown[][] = []
    killProcessTree(
      { pid: 777, kill: (() => { throw new Error('nope') }) as ChildProcess['kill'] },
      {
        platform: 'win32',
        spawnImpl: ((...args: unknown[]): unknown => {
          spawned.push(args)
          return { on: (): void => undefined, unref: (): void => undefined }
        }) as unknown as typeof nodeSpawn
      }
    )
    assert.equal(spawned.length, 1)
    const taskkillArgs = (spawned[0] ?? []) as unknown[]
    assert.equal(taskkillArgs[0], 'taskkill')
    assert.deepEqual(taskkillArgs[1], ['/PID', '777', '/T', '/F'])
  })
})

describe('stage 26 no generic process surface', () => {
  it('exposes exactly five runtime channels and no spawn surface', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const ipc = read(joinPath(process.cwd(), 'src', 'main', 'ipc', 'runtimes.ts'), 'utf8')
    for (const forbidden of ['executeCommand', 'runCommand', 'terminalExecute', 'startRuntime', 'spawnRuntime', 'kill-process', 'killProcess']) {
      assert.ok(!ipc.includes(forbidden), `no ${forbidden} channel`)
    }
    const preload = read(joinPath(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
    for (const forbidden of ['startRuntime', 'spawnRuntime', 'executeCommand', 'runCommand', 'terminalExecute']) {
      const occurrences = preload.split(forbidden).length - 1
      assert.equal(occurrences, 0, `no ${forbidden} bridge`)
    }
    const panel = read(joinPath(process.cwd(), 'src', 'renderer', 'src', 'features', 'sessions', 'SessionPanel.tsx'), 'utf8')
    assert.ok(!panel.includes('startRuntime'))
    assert.ok(!panel.includes('spawnRuntime'))
    assert.ok(!panel.includes('setInterval'))
  })

  it('runtime service and preview surface stay dependency-clean', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const service = read(joinPath(process.cwd(), 'src', 'main', 'project-runtime', 'project-runtime-service.ts'), 'utf8')
    for (const forbidden of [
      'WorkspaceFileWriteService',
      'acceptTransaction',
      'rejectTransaction',
      'rollbackTransaction',
      'TerminalService',
      'TerminalManager',
      'node-pty',
      'OpenAI',
      'generateText',
      'generateStructured',
      'credential'
    ]) {
      assert.ok(!service.includes(forbidden), `runtime service must not contain ${forbidden}`)
    }
    const preview = read(joinPath(process.cwd(), 'src', 'main', 'project-runtime', 'runtime-preview.ts'), 'utf8')
    assert.ok(!preview.includes('window.stark'), 'preview helpers never touch the bridge')
  })

  it('Brain stays tool-free of runtime_start', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const brain = read(joinPath(process.cwd(), 'src', 'main', 'ai', 'ai-brain-service.ts'), 'utf8')
    assert.ok(!brain.includes('runtime_start'))
  })
})
