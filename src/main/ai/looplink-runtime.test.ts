import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiBrainService } from './ai-brain-service'
import { AiCompletionService } from './ai-completion-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderTimeoutError, StarkHostedSignInRequiredError } from './errors'
import type {
  AiProviderAdapter,
  HostedSessionProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

/**
 * LoopLink runtime proof: Brain/Heart chains drive real model
 * execution (ordered failover, capability skips, failure
 * classification, empty safety). No network, no Supabase, no keys.
 */

const A = 'builtin:gpt-5.6-luna'
const B = 'builtin:claude-haiku-5.5'
const H1 = 'builtin:kimi-k2.7-code'
const H2 = 'builtin:deepseek-v4.1-flash'

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

function delegatePlan(): string {
  return JSON.stringify({
    action: 'delegate',
    planSummary: 'Delegate the tiny edit.',
    finalAnswer: null,
    workerInstruction: 'Apply the tiny edit.',
    workerProfile: 'general'
  })
}

class ChainAskAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  seenModels: string[] = []
  failModels = new Set<string>()
  failError: unknown = new ProviderTimeoutError()

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: A }, { id: B }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.seenModels.push(request.model)
    if (this.failModels.has(request.model)) {
      throw this.failError
    }
    return { text: `reply from ${request.model}` }
  }
}

class ChainBrainAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  seenStructured: string[] = []
  seenText: string[] = []
  failStructured = new Set<string>()
  failText = new Set<string>()
  failError: unknown = new ProviderTimeoutError()

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: A }, { id: B }, { id: H1 }, { id: H2 }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.seenText.push(request.model)
    if (this.failText.has(request.model)) {
      throw this.failError
    }
    return { text: `text from ${request.model}` }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.seenStructured.push(request.model)
    if (this.failStructured.has(request.model)) {
      throw this.failError
    }
    return { outputText: delegatePlan() }
  }
}

function openAsk(adapter: ChainAskAdapter): {
  db: DatabaseSync
  completion: AiCompletionService
  workspaces: WorkspaceRepository
  rows: CodingSessionRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const rows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const session: HostedSessionProvider = { getAccessToken: async () => 'ACCESS' }
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: session
  })
  const completion = new AiCompletionService(workspaces, rows, providerRows, providerService, registry, {
    operationGuard: new AiOperationGuard()
  })
  return { db, completion, workspaces, rows }
}

function openBrain(adapter: ChainBrainAdapter): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const rows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-looplink-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, rows)
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const session: HostedSessionProvider = { getAccessToken: async () => 'ACCESS' }
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: session
  })
  const brain = new AiBrainService(workspaces, rows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, brain }
}

describe('looplink Ask runtime', () => {
  it('Brain chain order [A,B]: A succeeds -> only A called, usage reports A', async () => {
    const adapter = new ChainAskAdapter()
    const h = openAsk(adapter)
    try {
      const sessionService = new CodingSessionService(h.workspaces, h.rows)
      const session = await sessionService.createSession({ workspaceId: h.workspaces.create({ rootPath: 'w-ask-a', displayName: 'w', now: 1 }).id })
      await sessionService.sendUserMessage({ workspaceId: session.workspaceId, sessionId: session.id, content: 'hi' })
      const result = await h.completion.generateResponse({
        workspaceId: session.workspaceId,
        sessionId: session.id,
        brainModels: [A, B]
      })
      assert.deepEqual(adapter.seenModels, [A])
      assert.ok(result.message.content.includes(A))
    } finally {
      h.db.close()
    }
  })

  it('A retryable fails -> B called, result from B', async () => {
    const adapter = new ChainAskAdapter()
    adapter.failModels.add(A)
    const h = openAsk(adapter)
    try {
      const sessionService = new CodingSessionService(h.workspaces, h.rows)
      const ws = h.workspaces.create({ rootPath: 'w-ask-b', displayName: 'w', now: 1 }).id
      const session = await sessionService.createSession({ workspaceId: ws })
      await sessionService.sendUserMessage({ workspaceId: ws, sessionId: session.id, content: 'hi' })
      const result = await h.completion.generateResponse({ workspaceId: ws, sessionId: session.id, brainModels: [A, B] })
      assert.deepEqual(adapter.seenModels, [A, B])
      assert.ok(result.message.content.includes(B))
    } finally {
      h.db.close()
    }
  })

  it('reorder changes the first model used', async () => {
    const first = new ChainAskAdapter()
    const h1 = openAsk(first)
    try {
      const svc = new CodingSessionService(h1.workspaces, h1.rows)
      const ws = h1.workspaces.create({ rootPath: 'w-ask-r1', displayName: 'w', now: 1 }).id
      const s = await svc.createSession({ workspaceId: ws })
      await svc.sendUserMessage({ workspaceId: ws, sessionId: s.id, content: 'hi' })
      await h1.completion.generateResponse({ workspaceId: ws, sessionId: s.id, brainModels: [A, B] })
      assert.deepEqual(first.seenModels, [A])
    } finally {
      h1.db.close()
    }
    const second = new ChainAskAdapter()
    const h2 = openAsk(second)
    try {
      const svc = new CodingSessionService(h2.workspaces, h2.rows)
      const ws = h2.workspaces.create({ rootPath: 'w-ask-r2', displayName: 'w', now: 1 }).id
      const s = await svc.createSession({ workspaceId: ws })
      await svc.sendUserMessage({ workspaceId: ws, sessionId: s.id, content: 'hi' })
      await h2.completion.generateResponse({ workspaceId: ws, sessionId: s.id, brainModels: [B, A] })
      assert.deepEqual(second.seenModels, [B])
    } finally {
      h2.db.close()
    }
  })

  it('auth failure does not fail over (B untouched)', async () => {
    const adapter = new ChainAskAdapter()
    adapter.failModels.add(A)
    adapter.failError = new StarkHostedSignInRequiredError()
    const h = openAsk(adapter)
    try {
      const svc = new CodingSessionService(h.workspaces, h.rows)
      const ws = h.workspaces.create({ rootPath: 'w-ask-auth', displayName: 'w', now: 1 }).id
      const s = await svc.createSession({ workspaceId: ws })
      await svc.sendUserMessage({ workspaceId: ws, sessionId: s.id, content: 'hi' })
      await assert.rejects(
        h.completion.generateResponse({ workspaceId: ws, sessionId: s.id, brainModels: [A, B] }),
        StarkHostedSignInRequiredError
      )
      assert.deepEqual(adapter.seenModels, [A])
    } finally {
      h.db.close()
    }
  })

  it('empty Brain chain fails safely with looplink_brain_empty', async () => {
    const adapter = new ChainAskAdapter()
    const h = openAsk(adapter)
    try {
      const svc = new CodingSessionService(h.workspaces, h.rows)
      const ws = h.workspaces.create({ rootPath: 'w-ask-empty', displayName: 'w', now: 1 }).id
      const s = await svc.createSession({ workspaceId: ws })
      await svc.sendUserMessage({ workspaceId: ws, sessionId: s.id, content: 'hi' })
      await assert.rejects(h.completion.generateResponse({ workspaceId: ws, sessionId: s.id, brainModels: [] }), (error: unknown) => {
        return error instanceof Error && error.message === 'looplink_brain_empty'
      })
      assert.deepEqual(adapter.seenModels, [])
    } finally {
      h.db.close()
    }
  })
})

describe('looplink Work runtime (Brain + Heart)', () => {
  it('Heart chain controls the Worker model (H1 succeeds -> H2 untouched)', async () => {
    const adapter = new ChainBrainAdapter()
    const h = openBrain(adapter)
    try {
      const s = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s.id, content: 'tiny edit' })
      const result = await h.brain.runBrain({
        workspaceId: h.workspaceId,
        sessionId: s.id,
        brainModels: [A],
        heartModels: [H1, H2]
      })
      assert.ok(adapter.seenStructured.includes(A), 'Brain plan must use Brain first model')
      assert.ok(adapter.seenText.includes(H1), 'Worker must use Heart first model')
      assert.ok(!adapter.seenText.slice(0, adapter.seenText.indexOf(H1)).includes(H2))
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.ok(workerStep?.modelAudit?.model === H1, 'run audit must report the actual Heart model')
      const planStep = result.run.steps.find((step) => step.kind === 'brain_plan')
      assert.ok(planStep?.modelAudit?.model === A, 'run audit must report the actual Brain model')
    } finally {
      h.db.close()
    }
  })

  it('Heart first fails retryably -> second Heart runs (no hardcoded GPT fallback)', async () => {
    const adapter = new ChainBrainAdapter()
    adapter.failText.add(H1)
    const h = openBrain(adapter)
    try {
      const s = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s.id, content: 'tiny edit' })
      const result = await h.brain.runBrain({
        workspaceId: h.workspaceId,
        sessionId: s.id,
        brainModels: [A],
        heartModels: [H1, H2]
      })
      assert.ok(adapter.seenText.includes(H1) && adapter.seenText.includes(H2))
      assert.ok(adapter.seenText.indexOf(H1) < adapter.seenText.indexOf(H2))
      const workerStep = result.run.steps.find((step) => step.kind === 'worker')
      assert.ok(workerStep?.modelAudit?.model === H2, 'audit must end on the successful Heart model')
      // No hardcoded fallback: the worker audit must be one of the
      // Heart chain ids, never an injected unrelated model.
      assert.ok([H1, H2].includes(workerStep?.modelAudit?.model as string))
      // LoopLink execution truth persists on the step (Phase E).
      assert.equal(workerStep?.modelAudit?.attempts, 2)
      assert.deepEqual([...(workerStep?.modelAudit?.attemptedModels ?? [])], [H1, H2])
      assert.deepEqual([...(workerStep?.modelAudit?.requestedChain ?? [])], [H1, H2])
      assert.ok(
        workerStep?.modelAudit?.failoverNote !== null &&
          (workerStep?.modelAudit?.failoverNote as string).includes(H2),
        'failover note must name the executor'
      )
      const planStep = result.run.steps.find((step) => step.kind === 'brain_plan')
      assert.equal(planStep?.modelAudit?.attempts, 1)
      assert.equal(planStep?.modelAudit?.failoverNote, null)
    } finally {
      h.db.close()
    }
  })

  it('Brain plan skips structured-incapable models (longcat never called)', async () => {
    const adapter = new ChainBrainAdapter()
    const h = openBrain(adapter)
    try {
      const s = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s.id, content: 'tiny edit' })
      await h.brain.runBrain({
        workspaceId: h.workspaceId,
        sessionId: s.id,
        brainModels: ['builtin:longcat-2.0', A],
        heartModels: [H1]
      })
      assert.ok(!adapter.seenStructured.includes('builtin:longcat-2.0'), 'longcat must be skipped for structured plan')
      assert.ok(adapter.seenStructured.includes(A))
    } finally {
      h.db.close()
    }
  })
})
