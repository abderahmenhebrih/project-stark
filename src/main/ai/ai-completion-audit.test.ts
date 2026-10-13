import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { AiCompletionService } from './ai-completion-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderRateLimitedError, ProviderTimeoutError, StarkHostedSignInRequiredError } from './errors'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

/**
 * Ask LoopLink execution audit proof (no network, no keys).
 * The completion service writes one orchestration run with a single
 * `ask` step per Ask when the runs repository is wired: winning
 * model plus attempts/failover metadata, linked to the final
 * assistant message. Legacy harnesses without runs keep working
 * with no run records.
 */

const A = 'builtin:gpt-5.6-luna'
const B = 'builtin:claude-haiku-5.5'

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

class ScriptedStarkAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  readonly calls: string[] = []
  constructor(private readonly behavior: Map<string, { text: string } | { error: unknown }>) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: A }, { id: B }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push(request.model)
    const scripted = this.behavior.get(request.model)
    if (scripted !== undefined && 'error' in scripted) {
      throw scripted.error
    }
    return { text: `reply from ${request.model}` }
  }
}

class FakeOpenAi implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }
  async generateText(): Promise<ProviderGenerateResult> {
    return { text: 'byok reply' }
  }
}

function openAuditHarness(behavior: Map<string, { text: string } | { error: unknown }>, clock: () => number = () => 9000): {
  db: DatabaseSync
  completion: AiCompletionService
  runs: OrchestrationRepository
  sessions: CodingSessionRepository
  stark: ScriptedStarkAdapter
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const stark = new ScriptedStarkAdapter(behavior)
  const registry = new ProviderRegistry()
  registry.register(stark)
  registry.register(new FakeOpenAi())
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: { getAccessToken: async () => 'ACCESS-MARKER' }
  })
  const runs = new OrchestrationRepository(db)
  const completion = new AiCompletionService(workspaces, sessions, providerRows, providerService, registry, {
    now: clock,
    runs
  })
  return { db, completion, runs, sessions, stark, providerService }
}

async function openSession(harness: { sessions: CodingSessionRepository }, workspaceId: number): Promise<number> {
  const sessionId = harness.sessions.createSession({ workspaceId, title: 's', now: 1000 })
  harness.sessions.appendMessage({ sessionId, role: 'user', content: 'Hello STARK', now: 2000, retitle: null })
  return sessionId
}

function createWorkspace(harness: { db: DatabaseSync }): number {
  const workspaces = new WorkspaceRepository(harness.db)
  return workspaces.create({ rootPath: 'w-audit', displayName: 'w', now: 1000 }).id
}

describe('ask LoopLink execution audit', () => {
  it('first model wins with attempts=1 and no failover', async () => {
    const harness = openAuditHarness(new Map())
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      const result = await harness.completion.generateResponse({ workspaceId, sessionId, effort: 'high', brainModels: [A, B] })
      assert.equal(result.message.content, `reply from ${A}`)
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'completed')
      assert.equal(recent[0]?.finalMessageId, result.message.id)
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.kind, 'ask')
      assert.equal(steps[0]?.status, 'completed')
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.providerId, 'stark')
      assert.equal(audit?.model, A)
      assert.equal(audit?.role, 'brain')
      assert.equal(audit?.attempts, 1)
      assert.equal(audit?.failoverNote, null)
      assert.deepEqual([...(audit?.attemptedModels ?? [])], [A])
      assert.deepEqual([...(audit?.requestedChain ?? [])], [A, B])
      assert.equal(audit?.requestedEffort, 'high')
      assert.deepEqual(harness.stark.calls, [A])
    } finally {
      harness.db.close()
    }
  })

  it('failover records the winner with attempts and attempted models', async () => {
    const harness = openAuditHarness(new Map([[A, { error: new ProviderTimeoutError() }]]))
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      const result = await harness.completion.generateResponse({ workspaceId, sessionId, brainModels: [A, B] })
      assert.equal(result.message.content, `reply from ${B}`)
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.model, B)
      assert.equal(audit?.attempts, 2)
      assert.deepEqual([...(audit?.attemptedModels ?? [])], [A, B])
      assert.ok(audit?.failoverNote !== null && audit.failoverNote.includes(B))
      assert.deepEqual(harness.stark.calls, [A, B])
    } finally {
      harness.db.close()
    }
  })

  it('auth failure stops immediately with a failed run and no assistant message', async () => {
    const harness = openAuditHarness(new Map([[A, { error: new StarkHostedSignInRequiredError() }]]))
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId, sessionId, brainModels: [A, B] }),
        StarkHostedSignInRequiredError
      )
      assert.deepEqual(harness.stark.calls, [A], 'B must never be attempted after auth failure')
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'failed')
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.kind, 'ask')
      assert.equal(steps[0]?.status, 'failed')
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      assert.equal(models.size, 0, 'failed Ask carries no winner audit')
      const messages = harness.sessions.listMessagesNewestFirst(sessionId, 10, null)
      assert.ok(messages.every((entry) => entry.role !== 'assistant'), 'no assistant message on failure')
    } finally {
      harness.db.close()
    }
  })

  it('all models failing surfaces the last error on a failed run', async () => {
    const harness = openAuditHarness(
      new Map([
        [A, { error: new ProviderTimeoutError() }],
        [B, { error: new ProviderRateLimitedError() }]
      ])
    )
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId, sessionId, brainModels: [A, B] }),
        ProviderRateLimitedError
      )
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'failed')
      assert.deepEqual(harness.stark.calls, [A, B])
    } finally {
      harness.db.close()
    }
  })

  it('legacy BYOK Ask is audited as a single attempt', async () => {
    const harness = openAuditHarness(new Map())
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.message.content, 'byok reply')
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.providerId, 'openai')
      assert.equal(audit?.model, 'gpt-4o')
      assert.equal(audit?.attempts, 1)
      assert.equal(audit?.failoverNote, null)
    } finally {
      harness.db.close()
    }
  })

  it('audit survives repository reload with identical fields', async () => {
    const harness = openAuditHarness(new Map([[A, { error: new ProviderTimeoutError() }]]))
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      await harness.completion.generateResponse({ workspaceId, sessionId, brainModels: [A, B] })
      const reread = new OrchestrationRepository(harness.db)
      const recent = reread.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      const steps = reread.findSteps(recent[0]?.id ?? -1)
      const models = reread.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.model, B)
      assert.equal(audit?.attempts, 2)
      assert.deepEqual([...(audit?.attemptedModels ?? [])], [A, B])
      assert.equal(audit?.requestedEffort, 'regular')
    } finally {
      harness.db.close()
    }
  })

  it('pre-audit rows load with null LoopLink metadata', async () => {
    const harness = openAuditHarness(new Map())
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      const runId = harness.runs.createRun({ workspaceId, sessionId, userMessageId: 1, now: 1000 })
      harness.runs.appendStep({
        runId,
        ordinal: 0,
        kind: 'brain_plan',
        status: 'completed',
        instruction: null,
        output: 'old',
        now: 1000
      })
      const models = harness.runs.findStepModels(runId)
      assert.equal(models.size, 0, 'steps without model rows stay audit-less')
    } finally {
      harness.db.close()
    }
  })

  it('renderer disabled lists are ignored: an enabled chain passes regardless of forgery', async () => {
    const harness = openAuditHarness(new Map([[A, { text: `reply from ${A}` }]]))
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      // Falsely claiming an enabled model is disabled changes nothing (main authority only).
      const result = await harness.completion.generateResponse({
        workspaceId,
        sessionId,
        brainModels: [A, B],
        disabledBrainModels: [B]
      })
      assert.ok(result.message.content.includes(A))
    } finally {
      harness.db.close()
    }
  })

  it('a chain containing an administratively unrunnable model is rejected before any provider call', async () => {
    const harness = openAuditHarness(new Map())
    try {
      const workspaceId = createWorkspace(harness)
      const sessionId = await openSession(harness, workspaceId)
      for (const forged of [
        { workspaceId, sessionId, brainModels: ['openai:whisper-1'] },
        { workspaceId, sessionId, brainModels: ['openai:whisper-1'], disabledBrainModels: [] },
        { workspaceId, sessionId, brainModels: ['openai:whisper-1'], disabledBrainModels: [A] }
      ]) {
        await assert.rejects(harness.completion.generateResponse(forged), /not available|invalid/i)
      }
      assert.deepEqual(harness.stark.calls, [], 'no provider call on unrunnable chains')
      assert.deepEqual(harness.runs.listRecentForSession(sessionId, 5), [], 'no run on unrunnable chains')
    } finally {
      harness.db.close()
    }
  })
})
