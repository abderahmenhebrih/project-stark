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

export class ScriptedBrainAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  structuredCalls: string[] = []
  textCalls: string[] = []
  nextPlan = ''
  nextWorkerText = ''
  nextSynthesisText = ''
  private textPhase: 'worker' | 'synthesis' = 'worker'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    this.textCalls.push(this.textPhase)
    if (this.textPhase === 'worker') {
      this.textPhase = 'synthesis'
      return { text: this.nextWorkerText }
    }
    return { text: this.nextSynthesisText }
  }

  async generateStructured(request: ProviderStructuredRequest & { readonly apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.structuredCalls.push('plan')
    return { outputText: this.nextPlan }
  }
}

export function openBrainHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  runs: OrchestrationRepository
  brain: AiBrainService
  providerService: AiProviderService
  adapter: ScriptedBrainAdapter
  guard: AiOperationGuard
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new ScriptedBrainAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: guard
  })
  return { db, dir, workspaceId, sessions, codingRows, runs, brain, providerService, adapter, guard }
}

export function closeBrainHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

export async function seedUserMessage(
  harness: ReturnType<typeof openBrainHarness>,
  content = 'Explain recursion.'
): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content })
  return session.id
}

describe('brain direct path', () => {
  it('answer plan persists DIRECT_OK with one provider call and no worker', async () => {
    const harness = openBrainHarness()
    try {
      const sessionId = await seedUserMessage(harness)
      harness.adapter.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 'Direct answer planned.',
        finalAnswer: 'DIRECT_OK',
        workerInstruction: null,
        workerProfile: null
      })
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(harness.adapter.structuredCalls.length, 1)
      assert.equal(harness.adapter.textCalls.length, 0)
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'DIRECT_OK')
      assert.equal(result.run.status, 'completed')
      assert.equal(result.run.action, 'answer')
      assert.equal(result.run.planSummary, 'Direct answer planned.')
      assert.equal(result.run.finalMessageId, result.message.id)
      assert.equal(result.run.steps.length, 1)
      assert.equal(result.run.steps[0]?.kind, 'brain_plan')
      assert.equal(result.run.steps[0]?.status, 'completed')
      // No hidden context: no file writes happened (no files exist at all).
      const messages = harness.codingRows.listMessagesNewestFirst(sessionId, 10, null)
      assert.equal(messages.length, 2)
    } finally {
      closeBrainHarness(harness)
    }
  })
})
