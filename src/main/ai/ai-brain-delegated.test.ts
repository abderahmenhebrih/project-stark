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

/** Records call order across both provider capabilities. */
class OrderedAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  order: string[] = []
  textPhase: 'worker' | 'synthesis' = 'worker'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    this.order.push(this.textPhase === 'worker' ? 'worker' : 'synthesis')
    if (this.textPhase === 'worker') {
      this.textPhase = 'synthesis'
      return { text: 'WORKER_OK' }
    }
    return { text: 'FINAL_OK' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.order.push('plan')
    return {
      outputText: JSON.stringify({
        action: 'delegate',
        planSummary: 'Needs a focused pass.',
        finalAnswer: null,
        workerInstruction: 'Inspect X',
        workerProfile: 'coding'
      })
    }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  providerService: AiProviderService
  adapter: OrderedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-delegated-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new OrderedAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, brain, providerService, adapter }
}

describe('brain delegated path', () => {
  it('delegate runs exactly plan, worker, synthesis and persists FINAL_OK', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Analyze this.' })
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.deepEqual(harness.adapter.order, ['plan', 'worker', 'synthesis'])
      assert.equal(result.message.content, 'FINAL_OK')
      assert.equal(result.run.status, 'completed')
      assert.equal(result.run.action, 'delegate')
      assert.deepEqual(
        result.run.steps.map((step) => step.kind),
        ['brain_plan', 'worker', 'brain_synthesis']
      )
      assert.ok(result.run.steps.every((step) => step.status === 'completed'))
      const workerStep = result.run.steps[1]
      assert.equal(workerStep?.instruction, 'Inspect X')
      assert.equal(workerStep?.output, 'WORKER_OK')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('no fourth provider call is possible', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.order.length, 3)
      // A second explicit run is a NEW run, not a fourth call of the first.
      harness.adapter.order = []
      harness.adapter.textPhase = 'worker'
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Again.' })
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.order.length, 3)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
