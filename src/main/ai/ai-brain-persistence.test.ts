import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
import type { ProviderModel } from '../../shared/providers/types'

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

class AnswerAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    return {
      outputText: JSON.stringify({
        action: 'answer',
        planSummary: 'Direct.',
        finalAnswer: 'DIRECT_OK',
        workerInstruction: null,
        workerProfile: null
      })
    }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  runs: OrchestrationRepository
  brain: AiBrainService
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-persist-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const registry = new ProviderRegistry()
  registry.register(new AnswerAdapter())
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, codingRows, runs, brain, providerService }
}

async function seed(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
  return session.id
}

describe('orchestration persistence', () => {
  it('creates a running run then completes with ordered steps', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.run.status, 'completed')
      assert.deepEqual(result.run.steps.map((step) => step.ordinal), [0])
      const stored = harness.runs.findRunById(result.run.id)
      assert.equal(stored?.status, 'completed')
      assert.equal(stored?.finalMessageId, result.message.id)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('final completion is atomic: fault leaves neither message nor completion', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      assert.throws(() =>
        harness.runs.completeRunWithAssistantMessage(
          { runId: 1, sessionId, content: 'x', action: 'answer', planSummary: 's', now: 2000 },
          { failAfterMessage: true }
        )
      )
      assert.equal(harness.codingRows.listMessagesNewestFirst(sessionId, 10, null).length, 1)
      assert.equal(harness.runs.findRunById(1), undefined)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('failed runs record a safe category with no final message', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      const runId = harness.runs.createRun({ workspaceId: harness.workspaceId, sessionId, userMessageId: 1, now: 2000 })
      harness.runs.failRun(runId, 'We couldn’t complete this work run.', 3000)
      const stored = harness.runs.findRunById(runId)
      assert.equal(stored?.status, 'failed')
      assert.equal(stored?.errorCategory, 'We couldn’t complete this work run.')
      assert.equal(stored?.finalMessageId, null)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('recent runs cap at 20 newest-first with session filtering', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      for (let index = 0; index < 22; index += 1) {
        const runId = harness.runs.createRun({
          workspaceId: harness.workspaceId,
          sessionId,
          userMessageId: 1,
          now: 2000 + index
        })
        harness.runs.failRun(runId, 'x', 2000 + index)
      }
      const recent = harness.runs.listRecentForSession(sessionId, 20)
      assert.equal(recent.length, 20)
      assert.equal(recent[0]?.createdAt, 2021)
      assert.deepEqual(harness.runs.listRecentForSession(999999, 20), [])
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('workspace ownership, cascade, and crash recovery behave', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      const runId = harness.runs.createRun({ workspaceId: harness.workspaceId, sessionId, userMessageId: 1, now: 2000 })
      assert.equal(harness.runs.markRunningAsInterrupted(3000), 1)
      assert.equal(harness.runs.findRunById(runId)?.status, 'interrupted')
      assert.equal(harness.runs.markRunningAsInterrupted(4000), 0)
      // Restart visibility: the interrupted run still reads back.
      const recent = await harness.brain.listRecentRuns({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'interrupted')
      // Cascade: deleting the session removes its runs and steps.
      harness.db.exec(`DELETE FROM coding_sessions WHERE id = ${sessionId}`)
      assert.equal(harness.runs.findRunById(runId), undefined)
      assert.deepEqual(harness.runs.findSteps(runId), [])
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
