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
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository } from '../worker-tools/worker-tool-repository'
import { WorkerToolApprovalService } from '../worker-tools/worker-tool-approval-service'
import { WorkerReadToolService } from '../worker-tools/worker-tool-service'
import { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageService } from './ai-usage-service'
import { AiUsageTracker } from './ai-usage-tracker'
import { ProviderTimeoutError } from '../ai/errors'

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
    return next as ProviderWorkerTurnResult
  }
}

const NOW = 5_000_000_000

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
  capService: CapabilityService
  tools: WorkerToolRepository
  runner: WorkerToolRunner
  adapter: ScriptedAdapter
  usageRepo: AiUsageRepository
  usageService: AiUsageService
  runs: OrchestrationRepository
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-usage-toolwork-'))
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
  const usageRepo = new AiUsageRepository(db)
  const usageService = new AiUsageService(usageRepo, registry, { now: () => NOW })
  const usageTracker = new AiUsageTracker(usageRepo, () => NOW)
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor,
    usage: { tracker: usageTracker, service: usageService }
  })
  return { db, dir, workspaceId, sessions, providerService, heart, capService, tools, runner, adapter, usageRepo, usageService, runs }
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
      { capability: 'attachment.import', mode: 'deny' },
      { capability: 'image.generate', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

function seedCalls(h: ReturnType<typeof openHarness>, model: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const { id } = h.usageRepo.reserveEvent({
      providerId: 'openai', model, operation: 'ask', role: 'ask',
      workspaceId: h.workspaceId, sessionId: null, runId: null, now: NOW - 1000 - index
    })
    h.usageRepo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: NOW - 999 - index })
  }
}

describe('tool work threshold routing', () => {
  it('worker fixed alternate serves tool turns while brain stays', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      seedCalls(h, 'model-B', 90)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-B', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'worker.fixed', providerId: 'openai', model: 'model-Y' }]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'WORKER_DONE' }
      ]
      h.adapter.textScript = ['FINAL_ANSWER']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      assert.deepEqual(
        h.adapter.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'worker-turn:model-Y', 'worker-turn:model-Y', 'text:model-A']
      )
      assert.ok(h.adapter.calls.length <= 7)
      const decisions = h.usageService.decisionsForRun(outcome.result.run.id)
      assert.equal(decisions.find((entry) => entry.role === 'worker')?.decision, 'threshold_alternate')
      assert.equal(decisions.find((entry) => entry.role === 'worker')?.selectedModel, 'model-Y')
      assert.equal(decisions.find((entry) => entry.role === 'brain')?.decision, 'base')
      // Usage events recorded for plan, both turns, and synthesis.
      const events = h.db.prepare('SELECT operation FROM ai_usage_events WHERE orchestration_run_id = ? ORDER BY id ASC').all(outcome.result.run.id) as {
        operation: string
      }[]
      assert.deepEqual(events.map((entry) => entry.operation), ['brain_plan', 'worker', 'worker_followup', 'brain_synthesis'])
      // Run assembly carries the decisions for the UI.
      assert.equal(outcome.result.run.usageRouteDecisions.length, 2)
    } finally {
      closeHarness(h)
    }
  })

  it('approval resume keeps the frozen threshold route after config change', async () => {
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
          { capability: 'attachment.import', mode: 'deny' },
          { capability: 'image.generate', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
          { capability: 'runtime.observe', mode: 'deny' },
          { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      seedCalls(h, 'model-B', 90)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-B', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'worker.fixed', providerId: 'openai', model: 'model-Y' }]
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
      // Change the live policy while parked: the resumed run must not re-route.
      h.usageService.updateConfig({ heartThresholdRoutingEnabled: false, limits: [], alternates: [] })
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      assert.deepEqual(
        h.adapter.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'worker-turn:model-Y', 'worker-turn:model-Y', 'text:model-A']
      )
      // A new run after the change uses the new policy (base worker).
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'Once more.' })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [{ kind: 'final_text', text: 'DIRECT_WORKER' }]
      h.adapter.textScript = ['FINAL_2']
      const second = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(second.kind, 'completed')
      if (second.kind !== 'completed') throw new Error('unreachable')
      const tail = h.adapter.calls.slice(4).map((call) => `${call.kind}:${call.model}`)
      assert.deepEqual(tail, ['structured:model-A', 'worker-turn:model-B', 'text:model-A'])
    } finally {
      closeHarness(h)
    }
  })

  it('provider failure after tools still disables recovery with threshold on', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedWork(h)
      allowAll(h)
      seedCalls(h, 'model-B', 90)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-B', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'worker.fixed', providerId: 'openai', model: 'model-Y' }]
      })
      h.adapter.planScript = [delegatePlan('coding')]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        new ProviderTimeoutError()
      ]
      h.adapter.textScript = []
      await assert.rejects(h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId }))
      // Threshold routing added no extra model call beyond the bounded turns.
      assert.ok(h.adapter.calls.length <= 7)
    } finally {
      closeHarness(h)
    }
  })
})
