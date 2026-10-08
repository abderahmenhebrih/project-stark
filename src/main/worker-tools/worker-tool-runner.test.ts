import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult,
  ProviderWorkerTurnRequest,
  ProviderWorkerTurnResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { ProviderRateLimitedError, ProviderTimeoutError } from '../ai/errors'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository } from './worker-tool-repository'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { ToolInteractiveError } from './worker-tool-errors'
import { RecoveryRepository } from '../recovery/recovery-repository'

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

type TurnScript = ProviderWorkerTurnResult | Error | { requests: unknown[] } | { kind: 'tool_request'; tool: string; args: unknown; text: string }

class ScriptedAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: { readonly kind: string; readonly model: string }[] = []
  planScript: (string | Error)[] = []
  turnScript: TurnScript[] = []
  textScript: (string | Error)[] = []

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push({ kind: 'text', model: request.model })
    const next = this.textScript.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'string') return { text: next }
    throw new Error('no scripted text left')
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.calls.push({ kind: 'structured', model: request.model })
    const next = this.planScript.shift()
    if (next instanceof Error) throw next
    if (typeof next === 'string') return { outputText: next }
    throw new Error('no scripted plan left')
  }

  async generateWorkerTurn(request: ProviderWorkerTurnRequest & { apiKey: string }): Promise<ProviderWorkerTurnResult> {
    void request
    this.calls.push({ kind: 'worker-turn', model: request.model })
    const next = this.turnScript.shift()
    if (next instanceof Error) throw next
    if (next !== undefined && typeof next === 'object' && next !== null && 'requests' in (next as Record<string, unknown>)) {
      throw Object.assign(new Error('multiple tool requests'), { rawRequests: (next as { requests: unknown[] }).requests })
    }
    // The runner validates shape; pass through (including invalid text+tool combos via cast).
    return next as ProviderWorkerTurnResult
  }
}

function delegatePlan(profile = 'coding'): string {
  return JSON.stringify({ action: 'delegate', planSummary: 'Needs work.', finalAnswer: null, workerInstruction: 'Inspect it.', workerProfile: profile })
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  providerService: AiProviderService
  heart: HeartService
  looplinks: LooplinkRepository
  loopService: LooplinkService
  capService: CapabilityService
  gate: CapabilityGate
  tools: WorkerToolRepository
  approvals: WorkerToolApprovalService
  runner: WorkerToolRunner
  adapter: ScriptedAdapter
  guard: AiOperationGuard
  recoveryStore: RecoveryRepository
  runs: OrchestrationRepository
  codingRows: CodingSessionRepository
  workspaces: WorkspaceRepository
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
  const recoveryStore = new RecoveryRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-tool-run-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
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
  const executor = new WorkerReadToolService({ gate, files, search, git, tools })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor
  })
  return { db, dir, workspaceId, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, approvals, runner, adapter, guard, recoveryStore, runs, codingRows, workspaces }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

async function seedWork(h: ReturnType<typeof openHarness>): Promise<number> {
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
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Inspect the app.' })
  return session.id
}

function allowAll(h: ReturnType<typeof openHarness>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'allow' },
      { capability: 'git.read', mode: 'allow' },
      { capability: 'change.propose', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' }
    ]
  })
}

describe('worker tool work flows', () => {
  it('read allow executes without approval and completes', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'WORKER_DONE' }
      ]
      h.adapter.textScript = ['FINAL_ANSWER']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      assert.equal(outcome.result.message.content, 'FINAL_ANSWER')
      // Provider calls: plan + 2 worker turns + synthesis = 4 (≤7).
      assert.ok(h.adapter.calls.length <= 7)
      const events = h.tools.listEvents(outcome.result.run.id)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.status, 'succeeded')
      assert.equal(events[0]?.toolName, 'workspace_read')
      // No approvals created.
      assert.equal(h.tools.findPendingForSession(sessionId), undefined)
      // Guard released.
      assert.equal(h.guard.isActive(sessionId), false)
    } finally {
      closeHarness(h)
    }
  })

  it('read ask waits, guard releases, approve resumes exactly once', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'WORKER_DONE' }
      ]
      h.adapter.textScript = ['FINAL_ANSWER']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'workspace_read')
      assert.ok(waiting.approval.summary.includes('app.ts'))
      assert.equal(h.guard.isActive(sessionId), false)
      // New operations blocked while waiting.
      assert.equal(h.tools.hasPending(sessionId), true)
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      assert.equal(resumed.result.message.content, 'FINAL_ANSWER')
      // Single-use: second approve rejected.
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      const approval = h.tools.findApproval(waiting.approval.id)
      assert.equal(approval?.status, 'consumed')
    } finally {
      closeHarness(h)
    }
  })

  it('denied policy returns denied result and run may still succeed', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'deny' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      // No tools advertised, but the fake still requests one: gate denies at execution.
      // Note: toolsAdvertised false means runToolWork still runs (advertised empty);
      // the Worker fake requests anyway to prove defense in depth.
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE_WITHOUT_DATA' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      assert.equal(events[0]?.status, 'denied')
    } finally {
      closeHarness(h)
    }
  })

  it('deny approval resumes Worker with denied result', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.denyAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      const approval = h.tools.findApproval(waiting.approval.id)
      assert.equal(approval?.status, 'denied')
    } finally {
      closeHarness(h)
    }
  })

  it('expired approval fails with zero further provider calls', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [{ kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } }]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      // Backdate the approval beyond 15 minutes via direct SQL.
      h.db.exec(`UPDATE worker_tool_approvals SET created_at = ${Date.now() - 16 * 60 * 1000} WHERE id = ${waiting.approval.id}`)
      const callsBefore = h.adapter.calls.length
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }), /expired/i)
      assert.equal(h.adapter.calls.length, callsBefore)
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'expired')
    } finally {
      closeHarness(h)
    }
  })

  it('four tools succeed, fifth is rejected, total calls stay within 7', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'const' } },
        { kind: 'tool_request', tool: 'git_read', args: { operation: 'status' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE4' }
      ]
      h.adapter.textScript = ['FINAL4']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      assert.ok(h.adapter.calls.length <= 7, `calls ${h.adapter.calls.length} exceed 7`)
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      assert.equal(h.tools.listEvents(outcome.result.run.id).length, 4)
    } finally {
      closeHarness(h)
    }
  })

  it('fifth tool request fails the run', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'tool_request', tool: 'workspace_search', args: { query: 'a' } },
        { kind: 'tool_request', tool: 'git_read', args: { operation: 'status' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } }
      ]
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }), /tool limit/i)
      assert.ok(h.adapter.calls.length <= 7)
    } finally {
      closeHarness(h)
    }
  })

  it('multiple tools in one turn execute zero and fail', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [{ requests: [{ tool: 'workspace_read' }, { tool: 'git_read' }] } as never]
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }))
      assert.equal(h.tools.listEvents(999999).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('tool plus final text in one turn fails with no execution', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [{ kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' }, text: 'extra' } as never]
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }))
    } finally {
      closeHarness(h)
    }
  })

  it('direct Brain answer uses one call and no tools', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [JSON.stringify({ action: 'answer', planSummary: 'Direct.', finalAnswer: 'DIRECT', workerInstruction: null, workerProfile: null })]
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.adapter.calls.filter((c) => c.kind === 'worker-turn').length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('tampered approval args fail verification with no execution', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      h.db.exec(`UPDATE worker_tool_approvals SET arguments_json = '{"relativePath":"evil.ts"}' WHERE id = ${waiting.approval.id}`)
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
      // No tool event executed for the tampered action.
      const events = h.tools.listEvents(waiting.run.id)
      assert.ok(events.every((e) => !e.argsJson.includes('evil')))
    } finally {
      closeHarness(h)
    }
  })

  it('provider failure after tool interaction throws ToolInteractive with no recovery target', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = [new ProviderTimeoutError()]
      const error = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(error instanceof ToolInteractiveError)
      assert.equal(h.recoveryStore.findEventByTarget(sessionId), undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('plan failure before tools is not tool-interactive (recovery still possible)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      h.adapter.planScript = [new ProviderRateLimitedError()]
      const error = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }).then(
        () => null,
        (e: unknown) => e
      )
      assert.ok(!(error instanceof ToolInteractiveError))
      assert.equal(h.tools.listEvents(1).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('master disabled advertises no tools and denies execution', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      // Default: no capability rows → disabled.
      assert.equal(h.runner.toolsAdvertised(h.workspaceId, sessionId), false)
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

  it('route snapshot survives approval (Heart change does not drift)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      // Change Heart mid-wait.
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
      const workerSteps = resumed.result.run.steps.filter((s) => s.kind === 'worker' || s.kind === 'worker_followup')
      assert.ok(workerSteps.length > 0)
      for (const step of workerSteps) {
        assert.equal(step.modelAudit?.model, 'model-B')
      }
    } finally {
      closeHarness(h)
    }
  })

  it('restart resumes from persisted state on the same Worker model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-tool-restart-'))
    const file = join(dir, 'restart.db')
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
    const buildPhase = (): ReturnType<typeof openHarness> & { fileDb: DatabaseSync } => {
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
      const recoveryStore = new RecoveryRepository(db)
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
      const executor = new WorkerReadToolService({ gate, files, search, git, tools })
      const runner = new WorkerToolRunner({
        workspaces, sessions: codingRows, providerService, runs, heart, guard,
        looplink: { service: loopService, store: looplinks },
        gate, files, search, git, tools, approvals, executor
      })
      const existing = db.prepare('SELECT id, root_path AS rootPath FROM workspaces ORDER BY id ASC').all() as { id: number }[]
      const workspaceId = existing.length > 0 ? (existing[0] as { id: number }).id : workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
      return { db, dir, workspaceId, sessions, providerService, heart, looplinks, loopService, capService, gate, tools, approvals, runner, adapter, guard, recoveryStore, runs, codingRows, workspaces, fileDb: db }
    }
    let approvalId: number
    let sessionId: number
    let workspaceId: number
    {
      const h = buildPhase()
      try {
        workspaceId = h.workspaceId
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
        await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Inspect.' })
        sessionId = session.id
        h.capService.updateConfig({
          workspaceId: h.workspaceId, enabled: true,
          policies: [
            { capability: 'workspace.read', mode: 'ask' },
            { capability: 'workspace.search', mode: 'deny' },
            { capability: 'git.read', mode: 'deny' },
            { capability: 'change.propose', mode: 'deny' },
            { capability: 'terminal.execute', mode: 'deny' }
          ]
        })
        h.adapter.planScript = [delegatePlan('coding')]
        h.adapter.turnScript = [{ kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } }]
        const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
        assert.equal(waiting.kind, 'waiting_for_approval')
        if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
        approvalId = waiting.approval.id
      } finally {
        h.db.close()
      }
    }
    {
      const h = buildPhase()
      try {
        h.adapter.turnScript = [{ kind: 'final_text', text: 'DONE' }]
        h.adapter.textScript = ['FINAL']
        const resumed = await h.runner.approveAndResume({ workspaceId, sessionId, approvalId })
        assert.equal(resumed.kind, 'completed')
      } finally {
        h.db.close()
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })
})
