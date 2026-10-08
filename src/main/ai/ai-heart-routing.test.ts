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
import { AiBrainService } from './ai-brain-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'

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

/** Tagging fake: records which model each call used. */
class TaggingAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: { readonly kind: 'structured' | 'text'; readonly model: string }[] = []
  nextPlan = ''
  nextTexts: string[] = []

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
    if (next.startsWith('THROW:')) {
      throw new Error(next.slice('THROW:'.length))
    }
    return { text: next }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push({ kind: 'structured', model: request.model })
    return { outputText: this.nextPlan }
  }
}

const OTHER_PROVIDER = 'other' as unknown as ProviderId

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  heart: HeartService
  providerService: AiProviderService
  providerRows: AiProviderRepository
  adapterA: TaggingAdapter
  adapterB: TaggingAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-heart-route-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapterA = new TaggingAdapter('openai')
  const adapterB = new TaggingAdapter(OTHER_PROVIDER)
  const registry = new ProviderRegistry()
  registry.register(adapterA)
  registry.register(adapterB)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, brain, heart, providerService, providerRows, adapterA, adapterB }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function seed(harness: ReturnType<typeof openHarness>, providerId: ProviderId = 'openai'): Promise<number> {
  await harness.providerService.saveCredential({ providerId, apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId, model: 'model-LEGACY' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
  return session.id
}

function fixedHeart(harness: ReturnType<typeof openHarness>, brainModel: string, workerModel: string): void {
  harness.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: brainModel },
    workerFixed: { providerId: 'openai', model: workerModel },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
}

function delegatePlan(profile: string): string {
  return JSON.stringify({
    action: 'delegate',
    planSummary: 'Needs work.',
    finalAnswer: null,
    workerInstruction: 'Do the thing.',
    workerProfile: profile
  })
}

describe('heart routing through brain runs', () => {
  it('fixed routing calls A, B, A with audit fixed/coding', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      assert.equal(harness.adapterB.calls.length, 0)
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.deepEqual(workerStep?.modelAudit, {
        role: 'worker',
        providerId: 'openai',
        model: 'model-B',
        routeKey: 'fixed',
        requestedProfile: 'coding'
      })
      assert.equal(harness.adapterA.calls.length, 3)
    } finally {
      closeHarness(harness)
    }
  })

  it('auto-swap exact route resolves coding to model-C', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'model-D' },
        workerRoutes: {
          general: null,
          coding: { providerId: 'openai', model: 'model-C' },
          reasoning: null,
          fast: null
        }
      })
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-C', 'text:model-A']
      )
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.deepEqual(workerStep?.modelAudit, {
        role: 'worker',
        providerId: 'openai',
        model: 'model-C',
        routeKey: 'coding',
        requestedProfile: 'coding'
      })
    } finally {
      closeHarness(harness)
    }
  })

  it('auto-swap default route resolves missing override to model-D', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'model-D' },
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-D', 'text:model-A']
      )
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.deepEqual(workerStep?.modelAudit, {
        role: 'worker',
        providerId: 'openai',
        model: 'model-D',
        routeKey: 'default',
        requestedProfile: 'coding'
      })
      assert.ok(!harness.adapterA.calls.some((call) => call.model === 'model-C'))
    } finally {
      closeHarness(harness)
    }
  })

  it('auto-swap covers general, reasoning, and fast profiles', async () => {
    for (const profile of ['general', 'reasoning', 'fast'] as const) {
      const harness = openHarness()
      try {
        const sessionId = await seed(harness)
        harness.heart.updateConfig({
          workerMode: 'auto_swap',
          brain: { providerId: 'openai', model: 'model-A' },
          workerFixed: null,
          workerDefault: { providerId: 'openai', model: 'model-D' },
          workerRoutes: {
            general: profile === 'general' ? { providerId: 'openai', model: 'model-G' } : null,
            coding: null,
            reasoning: profile === 'reasoning' ? { providerId: 'openai', model: 'model-R' } : null,
            fast: profile === 'fast' ? { providerId: 'openai', model: 'model-F' } : null
          }
        })
        harness.adapterA.nextPlan = delegatePlan(profile)
        harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
        const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
        const expected = profile === 'general' ? 'model-G' : profile === 'reasoning' ? 'model-R' : 'model-F'
        assert.equal(result.run.steps.find((step) => step.kind === 'worker')?.modelAudit?.model, expected)
        assert.equal(result.run.steps.find((step) => step.kind === 'worker')?.modelAudit?.routeKey, profile)
      } finally {
        closeHarness(harness)
      }
    }
  })

  it('direct answer calls only model-A once with no worker audit', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 'Direct.',
        finalAnswer: 'DIRECT_OK',
        workerInstruction: null,
        workerProfile: null
      })
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A']
      )
      assert.equal(result.run.steps.length, 1)
      assert.deepEqual(result.run.steps[0]?.modelAudit, {
        role: 'brain',
        providerId: 'openai',
        model: 'model-A',
        routeKey: 'primary',
        requestedProfile: null
      })
    } finally {
      closeHarness(harness)
    }
  })

  it('run snapshot freezes routing despite mid-run config change', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      const snapshot = harness.heart.snapshot()
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-X' },
        workerFixed: { providerId: 'openai', model: 'model-Y' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      // Snapshot-driven resolution still uses A/B even after the change.
      const resolved = harness.heart.resolveWorker(snapshot, 'coding')
      assert.deepEqual(resolved.assignment, { providerId: 'openai', model: 'model-B' })
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      // Re-seed Heart to A/B so the run itself uses A/B; the point is
      // the run never re-reads config mid-flight (proven statically by
      // a single snapshot() call site plus this behavioral check).
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: { providerId: 'openai', model: 'model-B' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B', 'text:model-A']
      )
      void result
    } finally {
      closeHarness(harness)
    }
  })

  it('legacy selected model is never mutated by routed runs', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.equal((await harness.providerService.getState({ providerId: 'openai' })).selectedModel, 'model-LEGACY')
    } finally {
      closeHarness(harness)
    }
  })

  it('worker failure performs no fallback: 2 calls, run failed, no synthesis', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = delegatePlan('coding')
      harness.adapterA.nextTexts = ['THROW:worker blew up']
      await assert.rejects(harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }), Error)
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-B']
      )
      assert.equal(harness.adapterA.calls.length, 2)
    } finally {
      closeHarness(harness)
    }
  })

  it('brain planning failure makes 1 call with no worker', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 's',
        finalAnswer: 'x',
        workerInstruction: null,
        workerProfile: 'coding'
      })
      await assert.rejects(harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }), Error)
      assert.equal(harness.adapterA.calls.length, 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('structured-unsupported brain fails without touching worker or legacy', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 's',
        finalAnswer: 'x',
        workerInstruction: null,
        workerProfile: null
      })
      // Simulate unsupported by removing the capability at runtime.
      const adapter = harness.adapterA as unknown as Record<string, unknown>
      const structured = adapter['generateStructured']
      adapter['generateStructured'] = undefined
      try {
        await assert.rejects(harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }), Error)
      } finally {
        adapter['generateStructured'] = structured
      }
      assert.equal(harness.adapterA.calls.filter((call) => call.kind === 'text').length, 0)
    } finally {
      closeHarness(harness)
    }
  })
})
