import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiBrainService } from '../ai/ai-brain-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageService } from './ai-usage-service'
import { AiUsageTracker } from './ai-usage-tracker'
import type { ProviderUsage } from '../usage/ai-usage-types'

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

/** Tagging fake with scripted per-call reported usage. */
class TaggingAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: { readonly kind: 'structured' | 'text'; readonly model: string }[] = []
  nextPlan = ''
  nextTexts: string[] = []
  nextUsage: (ProviderUsage | null)[] = []

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push({ kind: 'text', model: request.model })
    const next = this.nextTexts.shift()
    if (next === undefined) {
      throw new Error('no scripted text left')
    }
    return { text: next, usage: this.nextUsage.shift() ?? null }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push({ kind: 'structured', model: request.model })
    return { outputText: this.nextPlan, usage: this.nextUsage.shift() ?? null }
  }
}

const NOW = 5_000_000_000

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  heart: HeartService
  providerService: AiProviderService
  providerRows: AiProviderRepository
  usageRepo: AiUsageRepository
  usageService: AiUsageService
  adapterA: TaggingAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-usage-route-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapterA = new TaggingAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapterA)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const usageRepo = new AiUsageRepository(db)
  const usageService = new AiUsageService(usageRepo, registry, { now: () => NOW })
  const usageTracker = new AiUsageTracker(usageRepo, () => NOW)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: new AiOperationGuard(),
    usage: { tracker: usageTracker, service: usageService }
  })
  return { db, dir, workspaceId, sessions, brain, heart, providerService, providerRows, usageRepo, usageService, adapterA }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function seed(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
  harness.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'model-B' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
  return session.id
}

/** Seeds count successful tracked calls for a model (reported totals included). */
function seedCalls(
  harness: ReturnType<typeof openHarness>,
  model: string,
  count: number,
  totalTokens: number | null = 0
): void {
  for (let index = 0; index < count; index += 1) {
    const { id } = harness.usageRepo.reserveEvent({
      providerId: 'openai',
      model,
      operation: 'ask',
      role: 'ask',
      workspaceId: harness.workspaceId,
      sessionId: null,
      runId: null,
      now: NOW - 1000 - index
    })
    harness.usageRepo.finalizeSuccess(id, {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens,
      latencyMs: 1,
      now: NOW - 999 - index
    })
  }
}

function configureThreshold(
  harness: ReturnType<typeof openHarness>,
  model: string,
  maxCalls: number | null,
  maxTokens: number | null,
  alternateModel: string | null,
  routeKey: 'brain.primary' | 'worker.fixed' = 'brain.primary'
): void {
  harness.usageService.updateConfig({
    heartThresholdRoutingEnabled: true,
    limits: [{ providerId: 'openai', model, maxCalls24h: maxCalls, maxTotalTokens24h: maxTokens, switchAtPercent: 90 }],
    alternates:
      alternateModel === null
        ? []
        : [{ routeKey, providerId: 'openai', model: alternateModel }]
  })
}

function delegatePlan(profile = 'coding'): string {
  return JSON.stringify({
    action: 'delegate',
    planSummary: 'Needs work.',
    finalAnswer: null,
    workerInstruction: 'Do the thing.',
    workerProfile: profile
  })
}

function answerPlan(): string {
  return JSON.stringify({
    action: 'answer',
    planSummary: 'Direct.',
    finalAnswer: 'DIRECT_ANSWER',
    workerInstruction: null,
    workerProfile: null
  })
}

describe('heart threshold routing through brain runs', () => {
  it('brain threshold selects the alternate for plan and synthesis', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 90)
      configureThreshold(h, 'model-A', 100, null, 'model-X')
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-X', 'text:model-B', 'text:model-X']
      )
      const brainStep = result.run.steps.find((step) => step.kind === 'brain_plan')
      assert.equal(brainStep?.modelAudit?.model, 'model-X')
      const decisions = h.usageService.decisionsForRun(result.run.id)
      const brainDecision = decisions.find((entry) => entry.role === 'brain')
      assert.equal(brainDecision?.decision, 'threshold_alternate')
      assert.equal(brainDecision?.baseModel, 'model-A')
      assert.equal(brainDecision?.selectedModel, 'model-X')
      assert.equal(brainDecision?.calls24h, 90)
      const workerDecision = decisions.find((entry) => entry.role === 'worker')
      assert.equal(workerDecision?.decision, 'base')
      assert.equal(workerDecision?.selectedModel, 'model-B')
    } finally {
      closeHarness(h)
    }
  })

  it('worker fixed threshold selects its alternate while brain stays', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-B', 90)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-B', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'worker.fixed', providerId: 'openai', model: 'model-Y' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-Y', 'text:model-A']
      )
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.equal(workerStep?.modelAudit?.model, 'model-Y')
    } finally {
      closeHarness(h)
    }
  })

  it('worker auto-swap threshold selects the profile alternate', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'model-B' },
        workerRoutes: { general: null, coding: { providerId: 'openai', model: 'model-C' }, reasoning: null, fast: null }
      })
      seedCalls(h, 'model-C', 90)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-C', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'worker.coding', providerId: 'openai', model: 'model-D' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-D', 'text:model-A']
      )
      assert.equal(result.run.steps.find((step) => step.kind === 'worker')?.modelAudit?.model, 'model-D')
    } finally {
      closeHarness(h)
    }
  })

  it('threshold reached without alternate keeps the base route', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 100)
      configureThreshold(h, 'model-A', 100, null, null)
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      const decisions = h.usageService.decisionsForRun(result.run.id)
      assert.equal(decisions.find((entry) => entry.role === 'brain')?.decision, 'threshold_reached_no_alternate')
    } finally {
      closeHarness(h)
    }
  })

  it('disabled routing keeps the base route despite configured alternates', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 500)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: false,
        limits: [{ providerId: 'openai', model: 'model-A', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      assert.equal(h.usageService.decisionsForRun(result.run.id).find((entry) => entry.role === 'brain')?.decision, 'base')
    } finally {
      closeHarness(h)
    }
  })

  it('incomplete token telemetry never switches on tokens', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      // Token limit only, telemetry incomplete (one success without totals).
      seedCalls(h, 'model-A', 1, null)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-A', maxCalls24h: null, maxTotalTokens24h: 10, switchAtPercent: 10 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const incomplete = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.ok(incomplete.run.id > 0)
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      const summary = h.usageService.get24HourSummary([{ providerId: 'openai', model: 'model-A' }])
      assert.equal(summary.models.find((entry) => entry.model === 'model-A')?.tokenTelemetryComplete, false)
    } finally {
      closeHarness(h)
    }
  })

  it('call threshold still switches when token telemetry is incomplete', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 10, null)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-A', maxCalls24h: 10, maxTotalTokens24h: 10, switchAtPercent: 100 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-X', 'text:model-B', 'text:model-X']
      )
      const decision = h.usageService.decisionsForRun(result.run.id).find((entry) => entry.role === 'brain')
      assert.equal(decision?.decision, 'threshold_alternate')
      assert.equal(decision?.tokenTelemetryComplete, false)
    } finally {
      closeHarness(h)
    }
  })

  it('the alternate is never re-evaluated even when over its own threshold', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 90)
      seedCalls(h, 'model-X', 999)
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [
          { providerId: 'openai', model: 'model-A', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 },
          { providerId: 'openai', model: 'model-X', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 10 }
        ],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const chained = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.ok(chained.run.id > 0)
      // Exactly one alternate — no third model, no chain.
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-X', 'text:model-B', 'text:model-X']
      )
      assert.equal(h.adapterA.calls.length, 3)
    } finally {
      closeHarness(h)
    }
  })

  it('work-start snapshot freezes the run: plan call does not move synthesis', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 88)
      configureThreshold(h, 'model-A', 100, null, 'model-X')
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const first = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      // 88 + plan + synthesis = 90 observed, but synthesis still used A.
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      assert.equal(first.run.steps.find((step) => step.kind === 'brain_synthesis')?.modelAudit?.model, 'model-A')
      // Next run snapshots 90 and routes to the alternate.
      const sessions = new CodingSessionService(
        new WorkspaceRepository(h.db),
        new CodingSessionRepository(h.db)
      )
      await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'Again.' })
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.slice(3).map((call) => `${call.kind}:${call.model}`),
        ['structured:model-X', 'text:model-B', 'text:model-X']
      )
    } finally {
      closeHarness(h)
    }
  })

  it('direct brain answers use one alternate call with audit', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 90)
      configureThreshold(h, 'model-A', 100, null, 'model-X')
      h.adapterA.nextPlan = answerPlan()
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      assert.deepEqual(
        h.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-X']
      )
      assert.equal(result.run.steps.find((step) => step.kind === 'brain_plan')?.modelAudit?.model, 'model-X')
      assert.equal(result.message.content, 'DIRECT_ANSWER')
      assert.equal(h.usageService.decisionsForRun(result.run.id).length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('usage events record every work call with operations and reported usage', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextUsage = [
        { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        { inputTokens: 6, outputTokens: 7, totalTokens: 13 }
      ]
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      const events = h.db.prepare("SELECT operation, total_tokens AS total FROM ai_usage_events WHERE orchestration_run_id = ? ORDER BY id ASC").all(result.run.id) as {
        operation: string
        total: number
      }[]
      assert.deepEqual(events.map((entry) => entry.operation), ['brain_plan', 'worker', 'brain_synthesis'])
      assert.deepEqual(events.map((entry) => entry.total), [3, 9, 13])
      assert.ok(events.every((entry) => entry.total !== null))
    } finally {
      closeHarness(h)
    }
  })

  it('decision audit survives config changes and reloads', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      seedCalls(h, 'model-A', 90)
      configureThreshold(h, 'model-A', 100, null, 'model-X')
      h.adapterA.nextPlan = delegatePlan('coding')
      h.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await h.brain.runBrain({ workspaceId: h.workspaceId, sessionId })
      // Change the live config afterwards: history must not rewrite.
      h.usageService.updateConfig({ heartThresholdRoutingEnabled: false, limits: [], alternates: [] })
      const decisions = h.usageService.decisionsForRun(result.run.id)
      const brainDecision = decisions.find((entry) => entry.role === 'brain')
      assert.equal(brainDecision?.baseModel, 'model-A')
      assert.equal(brainDecision?.selectedModel, 'model-X')
      assert.equal(brainDecision?.decision, 'threshold_alternate')
      assert.equal(brainDecision?.calls24h, 90)
      // Run assembly carries the same rows for the UI.
      assert.deepEqual(
        result.run.usageRouteDecisions.map((entry) => `${entry.role}:${entry.decision}`),
        ['brain:threshold_alternate', 'worker:base']
      )
    } finally {
      closeHarness(h)
    }
  })
})
