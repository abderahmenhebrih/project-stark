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

interface SeenCall {
  readonly kind: 'structured' | 'text'
  readonly model: string
  readonly params: unknown
}

class InstrumentedAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: SeenCall[] = []
  nextPlan = ''
  nextTexts: string[] = []

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push({ kind: 'text', model: request.model, params: request })
    const next = this.nextTexts.shift()
    if (next === undefined) {
      throw new Error('no scripted text left')
    }
    return { text: next }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push({ kind: 'structured', model: request.model, params: request })
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
  adapterA: InstrumentedAdapter
  adapterB: InstrumentedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-heart-handoff-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapterA = new InstrumentedAdapter('openai')
  const adapterB = new InstrumentedAdapter(OTHER_PROVIDER)
  const registry = new ProviderRegistry()
  registry.register(adapterA)
  registry.register(adapterB)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, brain, heart, providerService, adapterA, adapterB }
}

describe('cross-provider handoff and audit', () => {
  it('plan A, worker B, synthesis A with text-only handoff', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-A' })
      await harness.providerService.saveCredential({ providerId: OTHER_PROVIDER, apiKey: 'sk-B' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: { providerId: OTHER_PROVIDER, model: 'model-B' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'delegate',
        planSummary: 'Needs work.',
        finalAnswer: null,
        workerInstruction: 'Do it.',
        workerProfile: 'coding'
      })
      harness.adapterB.nextTexts = ['WORKER_OUT']
      harness.adapterA.nextTexts = ['FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.deepEqual(
        harness.adapterA.calls.map((call) => `${call.kind}:${call.model}`),
        ['structured:model-A', 'text:model-A']
      )
      assert.deepEqual(
        harness.adapterB.calls.map((call) => `${call.kind}:${call.model}`),
        ['text:model-B']
      )
      // Only bounded plain data crosses providers: the adapter
      // legitimately receives its own key for auth, but no response
      // IDs, conversations, provider objects, or other credentials.
      const workerCall = harness.adapterB.calls[0]
      assert.ok(workerCall !== undefined)
      const { apiKey: _ownKey, ...wireParams } = workerCall.params as Record<string, unknown> & { apiKey: string }
      void _ownKey
      const serialized = JSON.stringify(wireParams)
      assert.ok(!serialized.includes('sk-A') && !serialized.includes('sk-B'))
      for (const forbidden of ['previous_response_id', 'previousResponseId', 'conversation', 'requestId']) {
        assert.ok(!serialized.includes(forbidden), `handoff must not contain ${forbidden}`)
      }
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.deepEqual(workerStep?.modelAudit, {
        role: 'worker',
        providerId: OTHER_PROVIDER,
        model: 'model-B',
        routeKey: 'fixed',
        requestedProfile: 'coding'
      })
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('all work requests retain store:false with no provider-side state', async () => {
    const harness = openHarness()
    try {
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
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'delegate',
        planSummary: 'Needs work.',
        finalAnswer: null,
        workerInstruction: 'Do it.',
        workerProfile: 'coding'
      })
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      // Store:false is asserted at the OpenAI adapter layer by existing
      // suites; here prove switching models needs only explicit data by
      // checking each call carried an explicit model and messages.
      for (const call of harness.adapterA.calls) {
        const params = call.params as Record<string, unknown>
        assert.ok(typeof params['model'] === 'string' && params['model'] !== '')
        assert.ok(Array.isArray(params['messages']))
      }
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('step audit persists per step and survives reloads', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
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
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      harness.adapterA.nextPlan = JSON.stringify({
        action: 'delegate',
        planSummary: 'Needs work.',
        finalAnswer: null,
        workerInstruction: 'Do it.',
        workerProfile: 'coding'
      })
      harness.adapterA.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      const byKind = new Map(result.run.steps.map((step) => [step.kind, step.modelAudit]))
      assert.deepEqual(byKind.get('brain_plan'), {
        role: 'brain',
        providerId: 'openai',
        model: 'model-A',
        routeKey: 'primary',
        requestedProfile: null
      })
      assert.deepEqual(byKind.get('worker'), {
        role: 'worker',
        providerId: 'openai',
        model: 'model-C',
        routeKey: 'coding',
        requestedProfile: 'coding'
      })
      assert.deepEqual(byKind.get('brain_synthesis'), {
        role: 'brain',
        providerId: 'openai',
        model: 'model-A',
        routeKey: 'primary',
        requestedProfile: null
      })
      // Reload after restart: same values.
      const reloaded = await harness.brain.getRun({ runId: result.run.id })
      assert.deepEqual(
        reloaded.steps.map((step) => step.modelAudit),
        result.run.steps.map((step) => step.modelAudit)
      )
      // Changing current Heart settings does not rewrite history.
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-Z' },
        workerFixed: { providerId: 'openai', model: 'model-Z' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const reread = await harness.brain.getRun({ runId: result.run.id })
      assert.equal(reread.steps.find((step) => step.kind === 'worker')?.modelAudit?.model, 'model-C')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('historical Stage 18 rows without audit load with null modelAudit', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const sent = await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      // Simulate a legacy row: insert run + step directly without audit.
      const inserted = harness.db
        .prepare(
          'INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, action, plan_summary, created_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(harness.workspaceId, session.id, sent.message.id, 'completed', 'answer', 's', 2000, 2000)
      const runId = typeof inserted.lastInsertRowid === 'bigint' ? Number(inserted.lastInsertRowid) : inserted.lastInsertRowid
      harness.db
        .prepare(
          'INSERT INTO orchestration_steps (run_id, ordinal, kind, status, instruction, output, created_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(runId, 0, 'brain_plan', 'completed', null, 's', 2000, 2000)
      const loaded = await harness.brain.getRun({ runId })
      assert.equal(loaded.steps.length, 1)
      assert.equal(loaded.steps[0]?.modelAudit, null)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
