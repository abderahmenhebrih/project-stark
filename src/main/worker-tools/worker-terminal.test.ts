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
import { WorkerToolRepository, hashToolArgs, hashState, serializeToolArgs } from './worker-tool-repository'
import { WorkerCommandRepository } from './worker-command-repository'
import { WorkerCommandService, buildWorkerCommandEnv, type SpawnFn } from './worker-command-service'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { capabilityForTool, workerToolSchemas, WORKER_TOOLS } from './worker-tool-registry'
import { ToolInteractiveError } from './worker-tool-errors'
import {
  WORKER_TERMINAL_DENY_MESSAGE,
  WORKER_TERMINAL_INVALID_POLICY_MESSAGE,
  WORKER_TERMINAL_USER_DENY_MESSAGE,
  buildTerminalApprovalSummary,
  parseTerminalExecuteArgs
} from './worker-terminal-validation'

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
  commands: WorkerCommandRepository
  commandService: WorkerCommandService
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

function openHarness(options?: { timeoutMs?: number; outputCapBytes?: number }): Harness {
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
  const commands = new WorkerCommandRepository(db)
  const txRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-terminal-'))
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
  const commandService = new WorkerCommandService({
    workspaces, gate, commands,
    spawnImpl: countingSpawn(spawnCounter),
    timeoutMs: options?.timeoutMs,
    outputCapBytes: options?.outputCapBytes
  })
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets, commands: commandService })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor
  })
  return { db, dir, root, workspaceId, workspaces, codingRows, runs, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, commands, commandService, approvals, executor, runner, txRows, adapter, guard, spawnCounter }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
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
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Run it.' })
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

/** Parks one terminal approval directly and returns its ids + canonical args. */
function parkTerminal(h: Harness, sessionId: number, runId: number, program: string, args: string[]): { approvalId: number; argsJson: string; argsHash: string; workspaceId: number; sessionId: number; runId: number } {
  const argsJson = serializeToolArgs({ program, args })
  const argsHash = hashToolArgs(argsJson)
  const messageId = h.codingRows.listMessagesNewestFirst(sessionId, 1, null)[0]?.id ?? 1
  const stateJson = JSON.stringify({ parked: true })
  const { approvalId } = h.tools.createApprovalAndPark({
    workspaceId: h.workspaceId, sessionId, runId, toolName: 'terminal_execute', capability: 'terminal.execute',
    argsJson, argsHash, summary: buildTerminalApprovalSummary({ program, args }),
    state: { toolCallCount: 1, workerInstruction: 'x', activeUserMessageId: messageId, continuityUsed: false, stateJson, stateHash: hashState(stateJson) },
    now: Date.now()
  })
  return { approvalId, argsJson, argsHash, workspaceId: h.workspaceId, sessionId, runId }
}

function createRun(h: Harness, sessionId: number): number {
  const messageId = h.codingRows.listMessagesNewestFirst(sessionId, 1, null)[0]?.id ?? 1
  return Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, messageId).lastInsertRowid)
}

describe('stage 25 registry, schema, and validation', () => {
  it('registry contains exactly eight tools with terminal mapping', () => {
    assert.deepEqual([...WORKER_TOOLS].sort(), ['change_propose', 'git_read', 'preview_inspect', 'runtime_observe', 'runtime_start', 'terminal_execute', 'workspace_read', 'workspace_search'].sort())
    assert.equal(capabilityForTool('terminal_execute'), 'terminal.execute')
    assert.equal(workerToolSchemas().length, 8)
  })

  it('terminal schema is strict program plus argv', () => {
    const schemas = workerToolSchemas()
    const terminal = schemas.find((s) => s.name === 'terminal_execute')
    assert.ok(terminal !== undefined)
    const parameters = terminal.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
    assert.deepEqual([...parameters.required].sort(), ['args', 'program'])
    assert.equal(parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['args', 'program'])
    const text = JSON.stringify(terminal.parameters)
    for (const forbidden of ['"command"', '"cwd"', '"env"', '"shell"', '"stdin"', '"timeout"', '"background"', '"detached"', '"workspaceId"', '"sessionId"']) {
      assert.ok(!text.includes(forbidden), `schema must not contain ${forbidden}`)
    }
  })

  it('parses valid program plus argv', () => {
    assert.deepEqual(parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'] }), { tool: 'terminal_execute', program: 'npm', args: ['test'] })
    assert.deepEqual(parseWorkerToolRequest('terminal_execute', { program: 'node.exe', args: [] }), { tool: 'terminal_execute', program: 'node.exe', args: [] })
    assert.deepEqual(parseTerminalExecuteArgs({ program: 'git', args: ['status'] }), { program: 'git', args: ['status'] })
  })

  it('rejects command strings and extra fields', () => {
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { command: 'npm test' }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], cwd: '/tmp' }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], env: {} }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], shell: true }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], stdin: 'x' }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], timeout: 5 }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], background: true }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], detached: true }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: ['test'], workspaceId: 1 }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm' }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: 'test' }))
    assert.throws(() => parseWorkerToolRequest('terminal_execute', { program: 'npm', args: null }))
  })

  it('validates bare executable names', () => {
    for (const program of ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'git', 'python', 'python3']) {
      assert.equal(parseTerminalExecuteArgs({ program, args: [] }).program, program)
    }
    for (const program of ['', '/bin/node', 'bin/node', '.\\node.exe', 'C:node', 'a:b', 'a\0b', 'a\nb', 'a\rb', '..', 'x'.repeat(129)]) {
      assert.throws(() => parseTerminalExecuteArgs({ program, args: [] }), `program ${JSON.stringify(program)} must reject`)
    }
  })

  it('enforces argument count, size, and shape bounds', () => {
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: Array.from({ length: 33 }, () => 'x') }))
    assert.doesNotThrow(() => parseTerminalExecuteArgs({ program: 'node', args: Array.from({ length: 32 }, () => 'x') }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: ['x'.repeat(2049)] }))
    assert.doesNotThrow(() => parseTerminalExecuteArgs({ program: 'node', args: ['x'.repeat(2048)] }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: ['a\0b'] }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: ['a\nb'] }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: ['a\rb'] }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: [7] }))
    assert.throws(() => parseTerminalExecuteArgs({ program: 'node', args: ['x'.repeat(12 * 1024)] }))
  })

  it('builds exact approval summaries with indexed argv', () => {
    const summary = buildTerminalApprovalSummary({ program: 'npm', args: ['test', '--runInBand'] })
    assert.ok(summary.includes('Run command: npm'))
    assert.ok(summary.includes('Program:'))
    assert.ok(summary.includes('[0] test'))
    assert.ok(summary.includes('[1] --runInBand'))
    assert.ok(summary.includes('Working directory:'))
    assert.ok(summary.includes('Workspace root'))
    assert.ok(!/[A-Za-z]:\\/.test(summary), 'summary carries no host absolute path')
  })
})

describe('stage 25 command repository', () => {
  it('schema is v17 with executions table, UNIQUE approval, and run index', () => {
    const h = openHarness()
    try {
      assert.equal(getUserVersion(h.db), 17)
      const table: unknown = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_command_executions'").get()
      assert.ok(table !== undefined)
      const index: unknown = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_worker_command_run_created'").get()
      assert.ok(index !== undefined)
      const columns = h.db.prepare("PRAGMA table_info(worker_command_executions)").all() as { name: string }[]
      const names = columns.map((c) => c.name)
      assert.ok(!names.includes('pid'), 'no PID column')
      assert.ok(names.includes('approval_id') && names.includes('status') && names.includes('stdout'))
    } finally {
      closeHarness(h)
    }
  })

  it('reserves at most once and consumes the approval atomically', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const { approvalId, argsJson, argsHash } = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      const { executionId } = h.commands.reserveExecution({ approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson, argsHash, now: 5 })
      assert.equal(h.commands.findById(executionId)?.status, 'launching')
      assert.equal(h.tools.findApproval(approvalId)?.status, 'consumed')
      assert.throws(() => h.commands.reserveExecution({ approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson, argsHash, now: 6 }))
      assert.equal(h.commands.listForRun(runId).length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('reservation verifies hash, scope, and pending state', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      assert.throws(() => h.commands.reserveExecution({ ...parked, program: 'node', argsJson: parked.argsJson, argsHash: 'bad', now: 5 }))
      assert.throws(() => h.commands.reserveExecution({ ...parked, workspaceId: 999, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, now: 5 }))
      assert.throws(() => h.commands.reserveExecution({ ...parked, runId: 999, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, now: 5 }))
      assert.equal(h.commands.listForRun(runId).length, 0)
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'pending')
    } finally {
      closeHarness(h)
    }
  })

  it('finalizes launching and running exactly once', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      const { executionId } = h.commands.reserveExecution({ ...parked, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, now: 5 })
      assert.equal(h.commands.markRunning(executionId, 6), true)
      assert.equal(h.commands.markRunning(executionId, 7), false)
      assert.equal(h.commands.finalizeExecution(executionId, { status: 'completed', exitCode: 0, signal: null, stdout: 'ok', stderr: '', outputBytes: 2, truncated: false, durationMs: 3 }, 9), true)
      assert.equal(h.commands.finalizeExecution(executionId, { status: 'completed', exitCode: 0, signal: null, stdout: 'x', stderr: '', outputBytes: 1, truncated: false, durationMs: 1 }, 10), false)
      assert.equal(h.commands.findById(executionId)?.stdout, 'ok')
    } finally {
      closeHarness(h)
    }
  })

  it('startup marks launching and running interrupted with run ids', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const first = parkTerminal(h, sessionId, runId, 'node', ['a'])
      const second = parkTerminal(h, sessionId, runId, 'node', ['b'])
      const one = h.commands.reserveExecution({ ...first, program: 'node', argsJson: first.argsJson, argsHash: first.argsHash, now: 5 })
      const two = h.commands.reserveExecution({ ...second, program: 'node', argsJson: second.argsJson, argsHash: second.argsHash, now: 5 })
      h.commands.markRunning(two.executionId, 6)
      const outcome = h.commands.markLaunchingAndRunningAsInterrupted(99)
      assert.equal(outcome.interrupted, 2)
      assert.deepEqual(outcome.runIds, [runId])
      assert.equal(h.commands.findById(one.executionId)?.status, 'interrupted')
      assert.equal(h.commands.findById(two.executionId)?.status, 'interrupted')
      // Completed rows are untouched.
      const third = parkTerminal(h, sessionId, runId, 'node', ['c'])
      const three = h.commands.reserveExecution({ ...third, program: 'node', argsJson: third.argsJson, argsHash: third.argsHash, now: 5 })
      h.commands.finalizeExecution(three.executionId, { status: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, truncated: false, durationMs: 1 }, 6)
      const again = h.commands.markLaunchingAndRunningAsInterrupted(100)
      assert.equal(again.interrupted, 0)
      assert.equal(h.commands.findById(three.executionId)?.status, 'completed')
    } finally {
      closeHarness(h)
    }
  })

  it('enforces foreign keys and workspace cascade', () => {
    const h = openHarness()
    try {
      h.db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        h.db.exec("INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, status, stdout, stderr, output_bytes, truncated, created_at) VALUES (999, 1, 1, 1, 'node', '[]', 'h', 'launching', '', '', 0, 0, 1)")
      )
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 25 process execution', () => {
  it('runs an approved echo fixture with exit 0', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "console.log('hello-terminal')"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'completed')
      assert.equal(outcome.result.exitCode, 0)
      assert.equal(outcome.result.stdout.trim(), 'hello-terminal')
      assert.equal(outcome.result.stderr, '')
      assert.equal(outcome.result.truncated, false)
      assert.equal(h.spawnCounter.calls, 1)
      const stored = h.commands.findById(outcome.executionId)
      assert.equal(stored?.status, 'completed')
      assert.ok((stored?.durationMs ?? -1) >= 0)
    } finally {
      closeHarness(h)
    }
  })

  it('uses the trusted Workspace root as cwd without exposing it in headers', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', 'console.log(process.cwd())'])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      const expected = await realpath(h.root)
      assert.equal(outcome.result.stdout.trim(), expected)
    } finally {
      closeHarness(h)
    }
  })

  it('sanitizes the environment of provider secrets', async () => {
    const h = openHarness()
    const previousKey = process.env['OPENAI_API_KEY']
    const previousToken = process.env['SOME_TOKEN']
    process.env['OPENAI_API_KEY'] = 'SECRET_TEST'
    process.env['SOME_TOKEN'] = 'TOKEN_TEST'
    try {
      const env = buildWorkerCommandEnv()
      assert.equal(env['CI'], '1')
      assert.ok(!('OPENAI_API_KEY' in env))
      assert.ok(!('SOME_TOKEN' in env))
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "console.log('key:' + (process.env.OPENAI_API_KEY || 'absent') + ' token:' + (process.env.SOME_TOKEN || 'absent'))"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.ok(outcome.result.stdout.includes('key:absent'))
      assert.ok(outcome.result.stdout.includes('token:absent'))
    } finally {
      if (previousKey === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = previousKey
      }
      if (previousToken === undefined) {
        delete process.env['SOME_TOKEN']
      } else {
        process.env['SOME_TOKEN'] = previousToken
      }
      closeHarness(h)
    }
  })

  it('closes stdin so interactive reads see EOF', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>console.log('end:'+n))"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'completed')
      assert.ok(outcome.result.stdout.includes('end:0'))
    } finally {
      closeHarness(h)
    }
  })

  it('passes shell metacharacters as inert argv data', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const metachars = ['&&', '|', '>', '$(echo x)', '`echo x`']
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...metachars])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.deepEqual(JSON.parse(outcome.result.stdout.trim()) as unknown, metachars)
      assert.equal(h.spawnCounter.calls, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('reports nonzero exits as completed with the exit code', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "console.error('boom');process.exit(7)"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'completed')
      assert.equal(outcome.result.exitCode, 7)
      assert.ok(outcome.result.stderr.includes('boom'))
      assert.equal(h.spawnCounter.calls, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('captures stdout and stderr separately', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "console.log('out-line');console.error('err-line')"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.ok(outcome.result.stdout.includes('out-line'))
      assert.ok(!outcome.result.stdout.includes('err-line'))
      assert.ok(outcome.result.stderr.includes('err-line'))
    } finally {
      closeHarness(h)
    }
  })

  it('normalizes invalid UTF-8 and control bytes safely', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "process.stdout.write(Buffer.from([0xff, 0x00, 0x01, 0x41]))"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.ok(!outcome.result.stdout.includes('\0'))
      assert.ok(outcome.result.stdout.includes('A'))
      // Persisted payload stays valid JSON with no NUL.
      const payload = JSON.stringify({ stdout: outcome.result.stdout, stderr: outcome.result.stderr })
      assert.ok(!payload.includes('\0'))
      JSON.parse(payload)
    } finally {
      closeHarness(h)
    }
  })

  it('times out long-running commands with only the child signalled', async () => {
    const h = openHarness({ timeoutMs: 300 })
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', 'setTimeout(()=>{}, 30000)'])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'timed_out')
      assert.equal(outcome.result.truncated, true)
      assert.equal(h.spawnCounter.calls, 1)
      assert.ok(h.spawnCounter.kills >= 1)
      assert.equal(h.commands.findByApproval(parked.approvalId)?.status, 'timed_out')
    } finally {
      closeHarness(h)
    }
  })

  it('enforces the output cap and terminates the process', async () => {
    const h = openHarness({ timeoutMs: 10000, outputCapBytes: 2048 })
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['-e', "let i=0;const t=setInterval(()=>{process.stdout.write('x'.repeat(65536));if(++i>50)clearInterval(t)},5)"])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'output_limit')
      assert.equal(outcome.result.truncated, true)
      assert.ok(outcome.result.outputBytes <= 2048)
      assert.equal(h.spawnCounter.calls, 1)
      assert.ok(h.spawnCounter.kills >= 1)
    } finally {
      closeHarness(h)
    }
  })

  it('records spawn failures without retry', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'stark-definitely-missing-bin', ['--version'])
      const outcome = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(outcome.kind, 'executed')
      if (outcome.kind !== 'executed') throw new Error('unreachable')
      assert.equal(outcome.result.status, 'spawn_failed')
      assert.equal(h.commands.findByApproval(parked.approvalId)?.status, 'spawn_failed')
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'consumed')
    } finally {
      closeHarness(h)
    }
  })

  it('rechecks the gate at execution: deny and fake-allow never spawn', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      setPolicies(h, 'deny')
      const denied = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(denied.kind, 'denied')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.findByApproval(parked.approvalId), undefined)
      // Fake persistent allow seeded past the service: still denied, never spawned.
      h.db.exec("UPDATE workspace_capability_policies SET mode = 'allow' WHERE workspace_id = 1 AND capability = 'terminal.execute'")
      const parked2 = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      const invalid = await h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked2.approvalId, argsJson: parked2.argsJson, argsHash: parked2.argsHash, now: 10 })
      assert.equal(invalid.kind, 'denied')
      if (invalid.kind !== 'denied') throw new Error('unreachable')
      assert.equal(invalid.reason, WORKER_TERMINAL_INVALID_POLICY_MESSAGE)
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.findByApproval(parked2.approvalId), undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('crash after reservation never re-executes: interrupted startup, consumed approval', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const runId = createRun(h, sessionId)
      const parked = parkTerminal(h, sessionId, runId, 'node', ['--version'])
      // Simulate a crash between reservation commit and spawn.
      const { executionId } = h.commands.reserveExecution({ approvalId: parked.approvalId, workspaceId: h.workspaceId, sessionId, runId, program: 'node', argsJson: parked.argsJson, argsHash: parked.argsHash, now: 10 })
      assert.equal(h.spawnCounter.calls, 0)
      const outcome = h.commands.markLaunchingAndRunningAsInterrupted(99)
      assert.equal(outcome.interrupted, 1)
      assert.deepEqual(outcome.runIds, [runId])
      assert.equal(h.commands.findById(executionId)?.status, 'interrupted')
      assert.equal(h.tools.findApproval(parked.approvalId)?.status, 'consumed')
      // Resume cannot execute: approval is consumed, reservation fails.
      await assert.rejects(h.commandService.executeApprovedTerminal({ workspaceId: h.workspaceId, sessionId, runId, approvalId: parked.approvalId, argsJson: parked.argsJson, argsHash: parked.argsHash, now: 100 }))
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.listForRun(runId).length, 1)
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 25 worker approval flows', () => {
  it('deny policy hides the schema and denies forced requests', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'deny')
      const internals = h.runner as unknown as {
        advertisedTools: (workspaceId: number, sessionId: number) => { readonly name: string }[]
      }
      assert.ok(!internals.advertisedTools(h.workspaceId, sessionId).some((t) => t.name === 'terminal_execute'))
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const terminal = events.find((e) => e.toolName === 'terminal_execute')
      assert.ok(terminal !== undefined && terminal.status === 'denied')
      assert.equal(h.commands.listForRun(outcome.result.run.id).length, 0)
      assert.equal(h.spawnCounter.calls, 0)
      const deniedState = h.tools.findState(outcome.result.run.id)
      assert.ok(deniedState !== undefined && deniedState.stateJson.includes(WORKER_TERMINAL_DENY_MESSAGE))
    } finally {
      closeHarness(h)
    }
  })

  it('ask parks with exact program and argv, then executes once on approve', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const internals = h.runner as unknown as {
        advertisedTools: (workspaceId: number, sessionId: number) => { readonly name: string }[]
      }
      assert.ok(internals.advertisedTools(h.workspaceId, sessionId).some((t) => t.name === 'terminal_execute'))
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['-e', "console.log('approved-run')"] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'terminal_execute')
      assert.ok(waiting.approval.summary.includes('Run command: node'))
      assert.ok(waiting.approval.summary.includes('Program:'))
      assert.ok(waiting.approval.summary.includes('[0] -e'))
      assert.ok(waiting.approval.summary.includes('Workspace root'))
      assert.ok(!waiting.approval.summary.includes(h.root))
      assert.equal(h.commands.listForRun(waiting.run.id).length, 0)
      assert.equal(h.spawnCounter.calls, 0)
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.spawnCounter.calls, 1)
      assert.equal(h.commands.listForRun(waiting.run.id).length, 1)
      assert.equal(h.commands.findByApproval(waiting.approval.id)?.status, 'completed')
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'consumed')
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      assert.equal(h.commands.listForRun(waiting.run.id).length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('human deny spawns nothing and the Worker continues', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
        { kind: 'final_text', text: 'DONE-AFTER-DENY' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.listForRun(waiting.run.id).length, 0)
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      assert.equal(resumed.result.message.content, 'FINAL')
    } finally {
      closeHarness(h)
    }
  })

  it('denied terminal history carries the user-deny copy', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      const events = h.tools.listEvents(waiting.run.id)
      const denied = events.find((e) => e.toolName === 'terminal_execute')
      assert.ok(denied !== undefined && denied.status === 'denied' && denied.approvalId === waiting.approval.id)
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'denied')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(WORKER_TERMINAL_USER_DENY_MESSAGE, 'The user denied this command.')
    } finally {
      closeHarness(h)
    }
  })

  it('tampered approval args never execute', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET arguments_json = '{"args":["evil.js"],"program":"node"}' WHERE id = ${waiting.approval.id}`)
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.listForRun(waiting.run.id).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('expired approvals execute nothing with no provider continuation', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET created_at = ${Date.now() - 16 * 60 * 1000} WHERE id = ${waiting.approval.id}`)
      const callsBefore = h.adapter.calls.length
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }), /expired/i)
      assert.equal(h.adapter.calls.length, callsBefore)
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.listForRun(waiting.run.id).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('policy revoke and master disable at approve time execute nothing', async () => {
    for (const mutate of ['revoke', 'master'] as const) {
      const h = openHarness()
      try {
        const sessionId = await seed(h)
        setPolicies(h, 'ask')
        h.adapter.planScript = [delegatePlan()]
        h.adapter.turnScript = [
          { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
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
        assert.equal(h.commands.listForRun(waiting.run.id).length, 0)
        const events = h.tools.listEvents(waiting.run.id)
        assert.ok(events.some((e) => e.toolName === 'terminal_execute' && e.status === 'denied'))
      } finally {
        closeHarness(h)
      }
    }
  })

  it('seeded persistent allow never auto-executes and stays unadvertised', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      // Bypass the service to seed the forbidden persistent allow.
      h.db.exec("UPDATE workspace_capability_policies SET mode = 'allow' WHERE workspace_id = 1 AND capability = 'terminal.execute'")
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const terminal = events.find((e) => e.toolName === 'terminal_execute')
      assert.ok(terminal !== undefined && terminal.status === 'denied')
      assert.equal(h.spawnCounter.calls, 0)
      assert.equal(h.commands.listForRun(outcome.result.run.id).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('nonzero exits continue the Worker with no retry', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['-e', 'process.exit(7)'] } },
        { kind: 'final_text', text: 'WORKER_SAW_FAILURE' }
      ]
      h.adapter.textScript = ['FINAL_AFTER_FAILURE']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.spawnCounter.calls, 1)
      const execution = h.commands.findByApproval(waiting.approval.id)
      assert.equal(execution?.status, 'completed')
      assert.equal(execution?.exitCode, 7)
    } finally {
      closeHarness(h)
    }
  })

  it('run details carry program, exit, duration, and streams as inert text', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['-e', "console.log('detail-out')"] } },
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
      const terminal = events.find((e) => e.toolName === 'terminal_execute')
      assert.ok(terminal !== undefined && terminal.status === 'succeeded')
      const payload = JSON.parse(terminal.payload) as { status: string; program: string; exitCode: number; stdout: string; durationMs: number }
      assert.equal(payload.status, 'completed')
      assert.equal(payload.program, 'node')
      assert.equal(payload.exitCode, 0)
      assert.ok(payload.stdout.includes('detail-out'))
      assert.ok(typeof payload.durationMs === 'number')
      assert.ok(!terminal.payload.includes(h.root))
      const run = h.runs.findRunById(resumed.result.run.id)
      assert.ok(run !== undefined)
      const steps = h.runs.findSteps(resumed.result.run.id)
      const workerOutputs = steps
        .filter((s) => s.kind === 'worker' || s.kind === 'worker_followup')
        .map((s) => s.output ?? '')
      assert.ok(workerOutputs.some((output) => output.includes('detail-out')), 'run details show the command result')
      assert.ok(workerOutputs.some((output) => output.includes('Run command: node')))
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 25 bounds, recovery, and interactions', () => {
  it('terminal counts toward the four-tool budget across all five tool types', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'allow' },
          { capability: 'git.read', mode: 'allow' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'ask' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'const' } },
        { kind: 'tool_request', tool: 'git_read', args: { operation: 'status' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } }
      ]
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }), /tool limit/i)
      assert.ok(h.adapter.calls.length <= 7)
      assert.equal(h.spawnCounter.calls, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('approved terminal plus synthesis stays within seven provider calls', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      // plan + 2 worker turns + synthesis = 4 (≤7); execution adds zero.
      assert.ok(h.adapter.calls.length <= 7)
    } finally {
      closeHarness(h)
    }
  })

  it('approved command route survives Heart changes mid-wait', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
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
    } finally {
      closeHarness(h)
    }
  })

  it('restart before approval resumes once on the same route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-terminal-restart-'))
    const file = join(dir, 'restart.db')
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
    const build = (): Harness & { fileDb: DatabaseSync } => {
      const db = new DatabaseSync(file)
      runMigrations(db, migrations)
      const workspaces = new WorkspaceRepository(db)
      const codingRows = new CodingSessionRepository(db)
      const providerRows = new AiProviderRepository(db)
      const runs = new OrchestrationRepository(db)
      const heartRows = new HeartRepository(db)
      const looplinks = new LooplinkRepository(db)
      const capStore = new CapabilityRepository(db)
      const tools = new WorkerToolRepository(db)
      const commands = new WorkerCommandRepository(db)
      const txRows = new ChangeTransactionRepository(db)
      const setRows = new ChangeSetRepository(db)
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
      const commandService = new WorkerCommandService({ workspaces, gate, commands, spawnImpl: countingSpawn(spawnCounter) })
      const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets, commands: commandService })
      const runner = new WorkerToolRunner({
        workspaces, sessions: codingRows, providerService, runs, heart, guard,
        looplink: { service: loopService, store: looplinks },
        gate, files, search, git, tools, approvals, executor
      })
      const existing = db.prepare('SELECT id FROM workspaces ORDER BY id ASC').all() as { id: number }[]
      const workspaceId = existing.length > 0 && existing[0] !== undefined ? existing[0].id : workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
      return { db, dir, root, workspaceId, workspaces, codingRows, runs, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, commands, commandService, approvals, executor, runner, txRows, adapter, guard, spawnCounter, fileDb: db }
    }
    let approvalId: number | undefined
    let sessionId: number | undefined
    let workspaceId: number | undefined
    {
      const h = build()
      try {
        workspaceId = h.workspaceId
        await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
        await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
        h.heart.updateConfig({
          workerMode: 'fixed', brain: { providerId: 'openai', model: 'model-A' },
          workerFixed: { providerId: 'openai', model: 'model-B' }, workerDefault: null,
          workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
        })
        const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
        await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Run it.' })
        sessionId = session.id
        setPolicies(h, 'ask')
        h.adapter.planScript = [delegatePlan()]
        h.adapter.turnScript = [
          { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } }
        ]
        const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
        assert.equal(waiting.kind, 'waiting_for_approval')
        if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
        approvalId = waiting.approval.id
      } finally {
        h.db.close()
      }
    }
    {
      const h = build()
      try {
        assert.ok(approvalId !== undefined && sessionId !== undefined && workspaceId !== undefined)
        h.adapter.turnScript = [{ kind: 'final_text', text: 'DONE' }]
        h.adapter.textScript = ['FINAL']
        const resumed = await h.runner.approveAndResume({ workspaceId, sessionId, approvalId })
        assert.equal(resumed.kind, 'completed')
        assert.equal(h.spawnCounter.calls, 1)
        assert.equal(h.commands.listForRun((resumed as { result: { run: { id: number } } }).result.run.id).length, 1)
      } finally {
        h.db.close()
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('command success then provider failure disables recovery but keeps audit', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
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
      assert.equal(h.commands.listForRun(waiting.run.id).length, 1)
      assert.equal(h.commands.findByApproval(waiting.approval.id)?.status, 'completed')
    } finally {
      closeHarness(h)
    }
  })

  it('looplink stays pending while waiting and consumes on success', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      setPolicies(h, 'ask')
      const created = await h.loopService.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: sessionId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, content: 'Continue it.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['--version'] } },
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
    } finally {
      closeHarness(h)
    }
  })

  it('terminal side effects stale later proposals without auto-accept', async () => {
    const h = openHarness()
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
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'terminal_execute', args: { program: 'node', args: ['-e', "require('fs').writeFileSync('a.ts','const a = 99\\n')"] } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'stale try', proposedContent: 'const a = 2\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      // The terminal approval parks the run; approve it, then script the rest.
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'stale try', proposedContent: 'const a = 2\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      // The command rewrote a.ts; the pre-command R1 is stale → no transaction.
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 99\n')
      const events = h.tools.listEvents(resumed.result.run.id)
      const propose = events.find((e) => e.toolName === 'change_propose')
      assert.ok(propose !== undefined && propose.status === 'failed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      // A fresh read mints a new revision the Worker could propose against.
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'Again.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'final_text', text: 'DONE2' }
      ]
      h.adapter.textScript = ['FINAL2']
      const second = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(second.kind, 'completed')
      if (second.kind !== 'completed') throw new Error('unreachable')
      const read = h.tools.listEvents(second.result.run.id).find((e) => e.toolName === 'workspace_read')
      assert.ok(read !== undefined && JSON.parse(read.payload) !== undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('no generic execution IPC exists for terminal commands', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const ipc = read(joinPath(process.cwd(), 'src', 'main', 'ipc', 'worker-tools.ts'), 'utf8')
    for (const forbidden of ['executeCommand', 'runCommand', 'terminalExecute']) {
      assert.ok(!ipc.includes(forbidden), `no ${forbidden} channel`)
    }
    const preload = read(joinPath(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
    for (const forbidden of ['executeCommand', 'runCommand', 'terminalExecute']) {
      assert.ok(!preload.includes(forbidden), `no ${forbidden} bridge`)
    }
  })

  it('renderer approval card carries terminal warnings with Deny and Approve only', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const panel = read(joinPath(process.cwd(), 'src', 'renderer', 'src', 'features', 'sessions', 'SessionPanel.tsx'), 'utf8')
    assert.ok(panel.includes('Capability: Terminal command'))
    assert.ok(panel.includes('This exact command will run with your user account from the Workspace root.'))
    assert.ok(panel.includes('It may modify files, start subprocesses, or access the network.'))
    assert.ok(panel.includes('This approval applies only to this exact program and argument list.'))
    assert.ok(panel.includes('Workspace root'))
    assert.ok(!panel.includes('Always allow'))
    assert.ok(!panel.includes('Approve command'))
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
  })

  it('command service never touches the human terminal', () => {
    // Behavioral: the harness wires no human terminal manager, yet every
    // execution above completed through the isolated runner only.
    const h = openHarness()
    try {
      assert.ok(!(h.commandService as unknown as Record<string, unknown>)['terminalManager'])
      assert.ok(!(h.commandService as unknown as Record<string, unknown>)['pty'])
    } finally {
      closeHarness(h)
    }
  })
})
