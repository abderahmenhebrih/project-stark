import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
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
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'

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
  structuredModels: string[] = []
  textModels: string[] = []
  textBodies: string[][] = []
  nextPlan = ''
  nextTexts: string[] = []
  failAtTextIndex = -1
  private textCount = 0

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.textModels.push(request.model)
    this.textBodies.push(request.messages.map((entry) => entry.content))
    const index = this.textCount
    this.textCount += 1
    if (index === this.failAtTextIndex) {
      throw new Error('provider boom')
    }
    const next = this.nextTexts.shift()
    if (next === undefined) {
      throw new Error('no scripted text left')
    }
    return { text: next }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.structuredModels.push(request.model)
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
  looplinks: LooplinkRepository
  loopService: LooplinkService
  adapter: ScriptedAdapter
  adapterB: ScriptedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-loop-work-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new ScriptedAdapter('openai')
  const adapterB = new ScriptedAdapter(OTHER_PROVIDER)
  const registry = new ProviderRegistry()
  registry.register(adapter)
  registry.register(adapterB)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const looplinks = new LooplinkRepository(db)
  const guard = new AiOperationGuard()
  const loopService = new LooplinkService(
    workspaces,
    codingRows,
    looplinks,
    guard,
    runs,
    setRows,
    changeRows
  )
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: guard,
    looplink: { service: loopService, store: looplinks }
  })
  return { db, dir, workspaceId, sessions, brain, heart, providerService, looplinks, loopService, adapter, adapterB }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function seedSource(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Source work.' })
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

function answerPlan(): string {
  return JSON.stringify({
    action: 'answer',
    planSummary: 'Direct.',
    finalAnswer: 'DIRECT_OK',
    workerInstruction: null,
    workerProfile: null
  })
}

function delegatePlan(profile: string): string {
  return JSON.stringify({
    action: 'delegate',
    planSummary: 'Needs work.',
    finalAnswer: null,
    workerInstruction: 'Do it.',
    workerProfile: profile
  })
}

describe('work continuity', () => {
  it('direct work consumes continuity atomically with one call', async () => {
    const harness = openHarness()
    try {
      const sourceId = await seedSource(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: sourceId })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue directly.'
      })
      harness.adapter.nextPlan = answerPlan()
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.deepEqual(harness.adapter.structuredModels, ['model-A'])
      assert.equal(result.message.content, 'DIRECT_OK')
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'consumed')
    } finally {
      closeHarness(harness)
    }
  })

  it('delegated work carries continuity without duplicating it into synthesis', async () => {
    const harness = openHarness()
    try {
      const sourceId = await seedSource(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: sourceId })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue with analysis.'
      })
      harness.adapter.nextPlan = delegatePlan('coding')
      harness.adapter.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.deepEqual(harness.adapter.structuredModels, ['model-A'])
      assert.deepEqual(harness.adapter.textModels, ['model-B', 'model-A'])
      // Worker input carries the bounded continuity section...
      assert.ok(harness.adapter.textBodies[0]?.join('\n').includes('[LOOPLINK CONTINUITY'))
      // ...but synthesis does not duplicate the full block.
      assert.ok(!(harness.adapter.textBodies[1]?.join('\n') ?? '').includes('[LOOPLINK CONTINUITY'))
      assert.equal(result.message.content, 'FINAL_OUT')
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'consumed')
    } finally {
      closeHarness(harness)
    }
  })

  it('work failure keeps continuity pending with run failed and guard released', async () => {
    const harness = openHarness()
    try {
      const sourceId = await seedSource(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: sourceId })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue.'
      })
      harness.adapter.nextPlan = delegatePlan('coding')
      harness.adapter.nextTexts = ['WORKER_OUT']
      harness.adapter.failAtTextIndex = 1
      await assert.rejects(
        harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }),
        Error
      )
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'pending')
    } finally {
      closeHarness(harness)
    }
  })

  it('heart transition A/B to X/Y applies to the target run', async () => {
    const harness = openHarness()
    try {
      const sourceId = await seedSource(harness)
      fixedHeart(harness, 'model-A', 'model-B')
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: sourceId })
      // Change Heart after the snapshot was taken: target uses X/Y.
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-X' },
        workerFixed: { providerId: 'openai', model: 'model-Y' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue with analysis.'
      })
      harness.adapter.nextPlan = delegatePlan('coding')
      harness.adapter.nextTexts = ['WORKER_OUT', 'FINAL_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.deepEqual(harness.adapter.structuredModels, ['model-X'])
      assert.deepEqual(harness.adapter.textModels, ['model-Y', 'model-X'])
      // Bounded source continuity still understood: the block traveled.
      assert.ok(harness.adapter.textBodies[0]?.join('\n').includes('Source work.'))
      assert.equal(result.message.content, 'FINAL_OUT')
    } finally {
      closeHarness(harness)
    }
  })

  it('cross-provider continuity carries no provider-side state', async () => {
    const harness = openHarness()
    try {
      const sourceId = await seedSource(harness)
      await harness.providerService.saveCredential({ providerId: OTHER_PROVIDER, apiKey: 'sk-other' })
      harness.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: { providerId: OTHER_PROVIDER, model: 'model-B' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: sourceId })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue.'
      })
      harness.adapter.nextPlan = delegatePlan('coding')
      harness.adapter.nextTexts = ['FINAL_OUT']
      harness.adapterB.nextTexts = ['WORKER_OUT']
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.deepEqual(harness.adapter.textModels, ['model-A'])
      assert.deepEqual(harness.adapterB.textModels, ['model-B'])
      // The worker call on provider B carries bounded text data only:
      // no credentials, response IDs, conversations, or SDK state.
      const wire = JSON.stringify(harness.adapterB.textBodies[0] ?? [])
      assert.ok(!wire.includes('sk-other') && !wire.includes('sk-test'))
      for (const forbidden of ['previous_response_id', 'previousResponseId', 'conversation_id', 'conversationId', 'requestId']) {
        assert.ok(!wire.includes(forbidden), `handoff must not contain ${forbidden}`)
      }
      assert.ok(wire.includes('Source work.'), 'historical continuity reaches provider B as data')
      assert.equal(result.message.content, 'FINAL_OUT')
    } finally {
      closeHarness(harness)
    }
  })
})
