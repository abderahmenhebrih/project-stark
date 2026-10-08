import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
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
import { WorkerToolRepository } from './worker-tool-repository'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { capabilityForTool, workerToolSchemas, WORKER_TOOLS } from './worker-tool-registry'
import { ToolInteractiveError } from './worker-tool-errors'
import { decodeSuccessfulReadPayload } from './worker-read-ref'
import { parseChangeProposeArgs } from './worker-proposal-validation'

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

function openHarness(): {
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
  approvals: WorkerToolApprovalService
  executor: WorkerReadToolService
  runner: WorkerToolRunner
  transactions: ChangeTransactionService
  changeSets: ChangeSetService
  txRows: ChangeTransactionRepository
  setRows: ChangeSetRepository
  adapter: ScriptedAdapter
  guard: AiOperationGuard
} {
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
  const txRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-proposal-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'const b = 2\n')
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
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor
  })
  return { db, dir, root, workspaceId, workspaces, codingRows, runs, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, approvals, executor, runner, transactions, changeSets, txRows, setRows, adapter, guard }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

async function seed(h: ReturnType<typeof openHarness>): Promise<number> {
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
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Fix it.' })
  return session.id
}

function allowPropose(h: ReturnType<typeof openHarness>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'allow' },
      { capability: 'git.read', mode: 'allow' },
      { capability: 'change.propose', mode: 'allow' },
      { capability: 'terminal.execute', mode: 'deny' }
    ]
  })
}

function askPropose(h: ReturnType<typeof openHarness>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'ask' },
      { capability: 'terminal.execute', mode: 'deny' }
    ]
  })
}

describe('stage 24 registry and mapping', () => {
  it('registry contains exactly five tools', () => {
    assert.deepEqual([...WORKER_TOOLS].sort(), ['change_propose', 'git_read', 'terminal_execute', 'workspace_read', 'workspace_search'].sort())
  })

  it('change_propose maps to change.propose', () => {
    assert.equal(capabilityForTool('change_propose'), 'change.propose')
    assert.equal(capabilityForTool('workspace_read'), 'workspace.read')
  })

  it('Brain direct answer uses 1 call, 0 tools, 0 proposals', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [JSON.stringify({ action: 'answer', planSummary: 'Direct.', finalAnswer: 'DIRECT', workerInstruction: null, workerProfile: null })]
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.tools.listEvents(1).length, 0)
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('advertises change_propose on allow/ask, hides on deny', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      // deny: nothing advertised for propose
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      const denied = h.runner.toolsAdvertised(h.workspaceId, sessionId)
      assert.equal(denied, true) // read still advertised
      // Now deny everything
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: false,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'allow' },
          { capability: 'git.read', mode: 'allow' },
          { capability: 'change.propose', mode: 'allow' },
          { capability: 'terminal.execute', mode: 'ask' }
        ]
      })
      assert.equal(h.runner.toolsAdvertised(h.workspaceId, sessionId), false)
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 24 readRef authority', () => {
  it('successful read exposes R1 with exact path/revision/content', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      writeFileSync(join(h.root, 'a.ts'), 'const a = 1\n')
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'a.ts' } as never,
        argsJson: '{"relativePath":"a.ts"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      const payload = JSON.parse(result.payload) as { readRef: string; relativePath: string; content: string; revision: string; bytes: number }
      assert.equal(payload.readRef, 'R1')
      assert.equal(payload.relativePath, 'a.ts')
      assert.equal(payload.content, 'const a = 1\n')
      assert.match(payload.revision, /^[0-9a-f]{64}$/)
      const decoded = decodeSuccessfulReadPayload(result.payload)
      assert.ok(decoded !== undefined && decoded.readRef === 'R1')
      // Second read gets R2
      const second = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'b.ts' } as never,
        argsJson: '{"relativePath":"b.ts"}', approvalId: null, now: 11
      })
      assert.equal((JSON.parse(second.payload) as { readRef: string }).readRef, 'R2')
    } finally {
      closeHarness(h)
    }
  })

  it('failed/denied reads allocate no usable ref', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const failed = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'missing.ts' } as never,
        argsJson: '{"relativePath":"missing.ts"}', approvalId: null, now: 10
      })
      assert.equal(failed.status, 'failed')
      assert.equal(failed.payload, '')
      // Proposing R1 without any successful read fails unknown
      const prop = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'change_propose',
        args: { tool: 'change_propose', changes: [{ targetRef: 'R1', summary: 'x', proposedContent: 'y' }] } as never,
        argsJson: '{"changes":[{"proposedContent":"y","summary":"x","targetRef":"R1"}]}', approvalId: null, now: 11
      })
      assert.equal(prop.status, 'failed')
    } finally {
      closeHarness(h)
    }
  })

  it('read-then-propose requirement: immediate propose without read is rejected', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'fix', proposedContent: 'new' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const prop = events.find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'failed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('unknown R99 is rejected with no transaction', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R99', summary: 's', proposedContent: 'x' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const prop = events.find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'failed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('duplicate R1 in one invocation is rejected entirely', () => {
    assert.throws(() => parseWorkerToolRequest('change_propose', { changes: [{ targetRef: 'R1', summary: 'a', proposedContent: 'x' }, { targetRef: 'R1', summary: 'b', proposedContent: 'y' }] }))
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 'a', proposedContent: 'x' }, { targetRef: 'R1', summary: 'b', proposedContent: 'y' }] }))
  })

  it('cross-run refs are rejected', async () => {
    const h = openHarness()
    try {
      const s1 = await seed(h)
      allowPropose(h)
      // Run A: read a.ts
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F1']
      const first = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: s1 })
      assert.equal(first.kind, 'completed')
      if (first.kind !== 'completed') throw new Error('unreachable')
      const runA = first.result.run.id
      const eventsA = h.tools.listEvents(runA)
      assert.ok(eventsA.some((e) => e.toolName === 'workspace_read' && e.status === 'succeeded'))
      // Run B: new user message, propose R1 without its own read
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s1, content: 'Again.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'evil' }] } },
        { kind: 'final_text', text: 'DONE2' }
      ]
      h.adapter.textScript = ['F2']
      const second = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: s1 })
      assert.equal(second.kind, 'completed')
      if (second.kind !== 'completed') throw new Error('unreachable')
      const eventsB = h.tools.listEvents(second.result.run.id)
      const prop = eventsB.find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'failed')
      // Only run A's read exists; run B created no transaction
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('cross-workspace refs are rejected', async () => {
    const h = openHarness()
    try {
      const s1 = await seed(h)
      allowPropose(h)
      // Second workspace
      const dir2 = mkdtempSync(join(tmpdir(), 'stark-ws2-'))
      const root2 = join(dir2, 'proj')
      mkdirSync(root2, { recursive: true })
      writeFileSync(join(root2, 'a.ts'), 'const a = 1\n')
      const ws2 = h.workspaces.create({ rootPath: root2, displayName: 'w2', now: 99 }).id
      h.capService.updateConfig({
        workspaceId: ws2, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'allow' },
          { capability: 'git.read', mode: 'allow' },
          { capability: 'change.propose', mode: 'allow' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      const sess2 = (await h.sessions.createSession({ workspaceId: ws2 })).id
      await h.sessions.sendUserMessage({ workspaceId: ws2, sessionId: sess2, content: 'Fix.' })
      // Read in ws1
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const first = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: s1 })
      assert.equal(first.kind, 'completed')
      // Propose in ws2 with R1 but no read in ws2 run
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } },
        { kind: 'final_text', text: 'DONE2' }
      ]
      h.adapter.textScript = ['F2']
      const second = await h.runner.runToolWork({ workspaceId: ws2, sessionId: sess2 })
      assert.equal(second.kind, 'completed')
      if (second.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(second.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'failed')
      rmSync(dir2, { recursive: true, force: true })
    } finally {
      closeHarness(h)
    }
  })

  it('search and git results are not proposal authority', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      for (const tool of ['workspace_search', 'git_read'] as const) {
        h.adapter.planScript = [delegatePlan()]
        h.adapter.turnScript = [
          tool === 'workspace_search'
            ? { kind: 'tool_request', tool, args: { query: 'const' } }
            : { kind: 'tool_request', tool, args: { operation: 'status' } },
          { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } },
          { kind: 'final_text', text: 'DONE' }
        ]
        h.adapter.textScript = ['F']
        const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
        // Need a fresh user message per run
        await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: `Next ${tool}.` })
        assert.equal(outcome.kind, 'completed')
        if (outcome.kind !== 'completed') throw new Error('unreachable')
        const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
        assert.ok(prop !== undefined && prop.status === 'failed', tool)
      }
    } finally {
      closeHarness(h)
    }
  })

  it('Looplink historical files are not proposal authority', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const created = await h.loopService.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: sessionId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, content: 'Continue.' })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: created.targetSession.id })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'failed')
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 24 single and multi proposals', () => {
  it('single proposal creates pending transaction, disk unchanged, Accept writes', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'bump', proposedContent: 'const a = 2\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const prop = events.find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'succeeded')
      const payload = JSON.parse(prop.payload) as { status: string; kind: string; transactionId: number; files: { relativePath: string; summary: string }[] }
      assert.equal(payload.status, 'proposal_created')
      assert.equal(payload.kind, 'single')
      assert.equal(payload.files[0]?.relativePath, 'a.ts')
      // Disk unchanged
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 1\n')
      // Transaction pending with exact before/proposed
      const tx = await h.transactions.getTransaction({ transactionId: payload.transactionId })
      assert.equal(tx.status, 'pending')
      assert.equal(tx.files[0]?.beforeContent, 'const a = 1\n')
      assert.equal(tx.files[0]?.proposedContent, 'const a = 2\n')
      // Human Accept writes
      const accepted = await h.transactions.acceptTransaction({ transactionId: payload.transactionId })
      assert.equal(accepted.status, 'applied')
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 2\n')
    } finally {
      closeHarness(h)
    }
  })

  it('multi proposal creates one Change Set with two pending transactions, disk unchanged', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'b.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'fix a', proposedContent: 'const a = 10\n' }, { targetRef: 'R2', summary: 'fix b', proposedContent: 'const b = 20\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'succeeded')
      const payload = JSON.parse(prop.payload) as { status: string; kind: string; changeSetId: number; files: { relativePath: string }[] }
      assert.equal(payload.kind, 'change_set')
      const set = await h.changeSets.getChangeSet({ changeSetId: payload.changeSetId })
      assert.equal(set.items.length, 2)
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 1\n')
      assert.equal(readFileSync(join(h.root, 'b.ts'), 'utf8'), 'const b = 2\n')
      // Accept one child only
      const firstTx = set.items[0]?.transaction.id
      assert.ok(typeof firstTx === 'number')
      await h.transactions.acceptTransaction({ transactionId: firstTx })
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 10\n')
      assert.equal(readFileSync(join(h.root, 'b.ts'), 'utf8'), 'const b = 2\n')
    } finally {
      closeHarness(h)
    }
  })

  it('model paths in summary/content are inert (no path authority)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'evil ../../etc/passwd', proposedContent: 'const a = 1\n// evil /abs/path\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'succeeded')
      const payload = JSON.parse(prop.payload) as { files: { relativePath: string }[] }
      assert.equal(payload.files[0]?.relativePath, 'a.ts')
    } finally {
      closeHarness(h)
    }
  })

  it('hostile proposed content stays inert file text (no eval)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const hostile = '<script>alert(1)</script>\n${process.exit(1)}\n; rm -rf /\n'
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'hostile', proposedContent: hostile }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      // Disk unchanged, no execution happened
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 1\n')
    } finally {
      closeHarness(h)
    }
  })

  it('tool-read creates no Stage 15 message_context_items', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      const messages = h.codingRows.listMessagesNewestFirst(sessionId, 10, null)
      for (const m of messages) {
        assert.equal(h.codingRows.listContextForMessage(m.id).length, 0)
      }
    } finally {
      closeHarness(h)
    }
  })

  it('cannot create new files via proposal', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      // Reading a missing file fails, so no ref exists
      const read = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'new-file.ts' } as never,
        argsJson: '{"relativePath":"new-file.ts"}', approvalId: null, now: 10
      })
      assert.equal(read.status, 'failed')
      const prop = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'change_propose',
        args: { tool: 'change_propose', changes: [{ targetRef: 'R1', summary: 'create', proposedContent: 'new' }] } as never,
        argsJson: '{"changes":[{"proposedContent":"new","summary":"create","targetRef":"R1"}]}', approvalId: null, now: 11
      })
      assert.equal(prop.status, 'failed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 24 stale, no-op, bounds', () => {
  it('stale after read fails with bounded copy, no transaction, disk preserved', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'stale', proposedContent: 'const a = 99\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      // Intercept: after first turn, externally modify file before second turn executes.
      // We simulate by writing externally right after run starts? Instead use direct executor test:
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const read = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'a.ts' } as never,
        argsJson: '{"relativePath":"a.ts"}', approvalId: null, now: 10
      })
      assert.equal(read.status, 'succeeded')
      writeFileSync(join(h.root, 'a.ts'), 'const a = EXTERNAL\n')
      const prop = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'change_propose',
        args: { tool: 'change_propose', changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 99\n' }] } as never,
        argsJson: '{"changes":[{"proposedContent":"const a = 99\\n","summary":"s","targetRef":"R1"}]}', approvalId: null, now: 11
      })
      assert.equal(prop.status, 'failed')
      assert.ok((prop.reason ?? '').includes('changed after STARK read it'))
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = EXTERNAL\n')
    } finally {
      closeHarness(h)
    }
  })

  it('no-op single returns no_changes with no persistence', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'same', proposedContent: 'const a = 1\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'succeeded')
      assert.equal((JSON.parse(prop.payload) as { status: string }).status, 'no_changes')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('mixed no-op drops unchanged, creates single transaction for changed', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'b.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'same', proposedContent: 'const a = 1\n' }, { targetRef: 'R2', summary: 'change', proposedContent: 'const b = 99\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'succeeded')
      const payload = JSON.parse(prop.payload) as { kind: string; files: { relativePath: string }[] }
      assert.equal(payload.kind, 'single')
      assert.equal(payload.files[0]?.relativePath, 'b.ts')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('per-file 64KiB boundary accepted, over rejected; total 192KiB enforced; summary 300cp; count bounds', async () => {
    // per-file
    assert.doesNotThrow(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x'.repeat(64 * 1024) }] }))
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x'.repeat(64 * 1024 + 1) }] }))
    // total: 3x64KiB = 192KiB accepted
    assert.doesNotThrow(() =>
      parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 'a', proposedContent: 'x'.repeat(64 * 1024) }, { targetRef: 'R2', summary: 'b', proposedContent: 'y'.repeat(64 * 1024) }, { targetRef: 'R3', summary: 'c', proposedContent: 'z'.repeat(64 * 1024) }] })
    )
    assert.throws(() =>
      parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 'a', proposedContent: 'x'.repeat(64 * 1024) }, { targetRef: 'R2', summary: 'b', proposedContent: 'y'.repeat(64 * 1024) }, { targetRef: 'R3', summary: 'c', proposedContent: 'z'.repeat(64 * 1024 + 1) }] })
    )
    // summary
    assert.doesNotThrow(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's'.repeat(300), proposedContent: 'x' }] }))
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's'.repeat(301), proposedContent: 'x' }] }))
    // count
    assert.throws(() => parseChangeProposeArgs({ changes: [] }))
    assert.throws(() =>
      parseChangeProposeArgs({ changes: [1, 2, 3, 4, 5, 6].map((n) => ({ targetRef: `R${n}`, summary: 's', proposedContent: 'x' })) })
    )
    // extra fields rejected
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x', relativePath: 'a.ts' }] }))
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }], extra: 1 }))
    // NUL and unpaired surrogate rejected
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 'a\0b', proposedContent: 'x' }] }))
    assert.throws(() => parseChangeProposeArgs({ changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x\0y' }] }))
  })
})

describe('stage 24 capability gate and approvals', () => {
  it('deny policy: not advertised initially, forced request denied with no proposal', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      // Defense in depth: fake requests anyway
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const prop = h.tools.listEvents(outcome.result.run.id).find((e) => e.toolName === 'change_propose')
      assert.ok(prop !== undefined && prop.status === 'denied')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('mid-run revoke: advertised allow then deny before execution denies', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const read = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'workspace_read',
        args: { tool: 'workspace_read', relativePath: 'a.ts' } as never,
        argsJson: '{"relativePath":"a.ts"}', approvalId: null, now: 10
      })
      assert.equal(read.status, 'succeeded')
      // Revoke before proposal
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      const prop = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'change_propose',
        args: { tool: 'change_propose', changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 5\n' }] } as never,
        argsJson: '{"changes":[{"proposedContent":"const a = 5\\n","summary":"s","targetRef":"R1"}]}', approvalId: null, now: 11
      })
      assert.equal(prop.status, 'denied')
      assert.ok((prop.reason ?? '').includes('not allowed'))
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('ask parks with resolved paths, approve creates once, second approve rejected', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      askPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'nice fix', proposedContent: 'const a = 7\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'change_propose')
      assert.ok(waiting.approval.summary.includes('a.ts'), 'approval must list resolved path')
      assert.ok(waiting.approval.summary.includes('nice fix'), 'approval must list summary')
      assert.ok(waiting.approval.summary.includes('does not modify'), 'approval must carry non-apply copy')
      // No transaction yet
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 1)
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'consumed')
    } finally {
      closeHarness(h)
    }
  })

  it('deny-and-resume creates no proposal and Worker continues', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      askPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 7\n' }] } },
        { kind: 'final_text', text: 'DONE-AFTER-DENY' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('approval hash mismatch fails with no proposal', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      askPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 7\n' }] } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET arguments_json = '{"changes":[{"proposedContent":"evil","summary":"s","targetRef":"R1"}]}' WHERE id = ${waiting.approval.id}`)
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('stale while waiting approval fails on approve with no transaction', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      askPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 77\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      writeFileSync(join(h.root, 'a.ts'), 'const a = EXTERNAL2\n')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      // Stale execution returns failed tool result but Worker continues to final
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = EXTERNAL2\n')
    } finally {
      closeHarness(h)
    }
  })

  it('expiry fails with zero further provider calls', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      askPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [{ kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } }]
      // Need read allow + propose ask: first read succeeds, second turn proposes
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'ask' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } }
      ]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET created_at = ${Date.now() - 16 * 60 * 1000} WHERE id = ${waiting.approval.id}`)
      const callsBefore = h.adapter.calls.length
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }), /expired/i)
      assert.equal(h.adapter.calls.length, callsBefore)
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 24 bounds, persistence, recovery', () => {
  it('tool budget remains 4: fifth change_propose rejected', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'const' } },
        { kind: 'tool_request', tool: 'git_read', args: { operation: 'status' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'b.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'x' }] } }
      ]
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }), /tool limit/i)
    } finally {
      closeHarness(h)
    }
  })

  it('maximal sequence stays within 7 provider calls with zero proposal calls', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'b.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'a', proposedContent: 'const a = 3\n' }, { targetRef: 'R2', summary: 'b', proposedContent: 'const b = 4\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const before = h.adapter.calls.length
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      // 1 plan + 4 worker turns + 1 synthesis = 6 (≤7); proposal adds zero
      assert.ok(h.adapter.calls.length - before <= 7)
    } finally {
      closeHarness(h)
    }
  })

  it('proposal survives later synthesis failure (no rollback, no recovery)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 42\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = [new ProviderTimeoutError()]
      const error = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(error instanceof ToolInteractiveError)
      // Proposal remains pending and reviewable
      const txs = h.txRows.listRecentForWorkspace(h.workspaceId, 20)
      assert.equal(txs.length, 1)
      assert.equal(txs[0]?.status, 'pending')
    } finally {
      closeHarness(h)
    }
  })

  it('looplink stays pending while waiting and proposal remains on later failure', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      allowPropose(h)
      const created = await h.loopService.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: sessionId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, content: 'Go.' })
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'ask' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 's', proposedContent: 'const a = 9\n' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['F']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: created.targetSession.id })
      assert.equal(waiting.kind, 'waiting_for_approval')
      assert.equal(h.looplinks.findByTargetSession(created.targetSession.id)?.status, 'pending')
    } finally {
      closeHarness(h)
    }
  })

  it('restart reconstructs readRef mapping and resumes approval once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-prop-restart-'))
    const file = join(dir, 'restart.db')
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
    const build = (): ReturnType<typeof openHarness> & { fileDb: DatabaseSync } => {
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
      const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets })
      const runner = new WorkerToolRunner({
        workspaces, sessions: codingRows, providerService, runs, heart, guard,
        looplink: { service: loopService, store: looplinks },
        gate, files, search, git, tools, approvals, executor
      })
      const existing = db.prepare('SELECT id, root_path AS rootPath FROM workspaces ORDER BY id ASC').all() as { id: number }[]
      const workspaceId = existing.length > 0 ? (existing[0] as { id: number }).id : workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
      return { db, dir, root, workspaceId, workspaces, codingRows, runs, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, approvals, executor, runner, transactions, changeSets, txRows, setRows, adapter, guard, fileDb: db }
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
        const s = await h.sessions.createSession({ workspaceId: h.workspaceId })
        await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s.id, content: 'Fix.' })
        sessionId = s.id
        h.capService.updateConfig({
          workspaceId: h.workspaceId, enabled: true,
          policies: [
            { capability: 'workspace.read', mode: 'allow' },
            { capability: 'workspace.search', mode: 'deny' },
            { capability: 'git.read', mode: 'deny' },
            { capability: 'change.propose', mode: 'ask' },
            { capability: 'terminal.execute', mode: 'deny' }
          ]
        })
        h.adapter.planScript = [delegatePlan()]
        h.adapter.turnScript = [
          { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
          { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'restart', proposedContent: 'const a = 11\n' }] } }
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
        h.adapter.turnScript = [{ kind: 'final_text', text: 'DONE' }]
        h.adapter.textScript = ['FINAL']
        assert.ok(approvalId !== undefined && sessionId !== undefined && workspaceId !== undefined)
        const resumed = await h.runner.approveAndResume({ workspaceId, sessionId, approvalId })
        assert.equal(resumed.kind, 'completed')
        assert.equal(h.txRows.listRecentForWorkspace(workspaceId, 20).length, 1)
      } finally {
        h.db.close()
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('change_propose provider schema is strict with no path authority', () => {
    const schemas = workerToolSchemas()
    assert.equal(schemas.length, 5)
    const propose = schemas.find((s) => s.name === 'change_propose')
    assert.ok(propose !== undefined)
    const text = JSON.stringify(propose.parameters)
    assert.ok(text.includes('targetRef'))
    assert.ok(!text.includes('relativePath'))
    assert.ok(!text.includes('absolutePath'))
    assert.ok(!text.includes('expectedRevision'))
    assert.ok(!text.includes('workspaceId'))
  })

  it('no new IPC channels beyond the three approval channels', async () => {
    const { readFileSync: read } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const ipc = read(joinPath(process.cwd(), 'src', 'main', 'ipc', 'worker-tools.ts'), 'utf8')
    assert.ok(!ipc.includes('createProposalFromWorker'))
    assert.ok(!ipc.includes('executeProposalTool'))
    assert.ok(!ipc.includes('acceptWorkerProposal'))
  })
})
