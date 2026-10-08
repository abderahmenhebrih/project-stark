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
import { InvalidBrainPlanError } from './ai-brain-errors'

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
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  structuredCalls = 0
  textCalls = 0
  nextPlan = ''

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    this.textCalls += 1
    return { text: 'unexpected' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.structuredCalls += 1
    return { outputText: this.nextPlan }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  providerService: AiProviderService
  adapter: ScriptedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-plan-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new ScriptedAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, brain, providerService, adapter }
}

async function seed(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
  return session.id
}

function runCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM orchestration_runs').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('brain plan validation', () => {
  const cases: [string, unknown][] = [
    ['unknown action', { action: 'think', planSummary: 's', finalAnswer: 'a', workerInstruction: null, workerProfile: null }],
    ['empty planSummary', { action: 'answer', planSummary: '   ', finalAnswer: 'a', workerInstruction: null, workerProfile: null }],
    ['overlong planSummary', { action: 'answer', planSummary: 's'.repeat(501), finalAnswer: 'a', workerInstruction: null, workerProfile: null }],
    ['answer with null finalAnswer', { action: 'answer', planSummary: 's', finalAnswer: null, workerInstruction: null, workerProfile: null }],
    ['answer with workerInstruction', { action: 'answer', planSummary: 's', finalAnswer: 'a', workerInstruction: 'w', workerProfile: null }],
    ['answer with non-null profile', { action: 'answer', planSummary: 's', finalAnswer: 'a', workerInstruction: null, workerProfile: 'coding' }],
    ['delegate with finalAnswer', { action: 'delegate', planSummary: 's', finalAnswer: 'a', workerInstruction: 'w', workerProfile: 'coding' }],
    ['delegate without workerInstruction', { action: 'delegate', planSummary: 's', finalAnswer: null, workerInstruction: null, workerProfile: 'coding' }],
    ['delegate with empty workerInstruction', { action: 'delegate', planSummary: 's', finalAnswer: null, workerInstruction: '  ', workerProfile: 'coding' }],
    ['delegate with null profile', { action: 'delegate', planSummary: 's', finalAnswer: null, workerInstruction: 'w', workerProfile: null }],
    ['delegate with unknown profile', { action: 'delegate', planSummary: 's', finalAnswer: null, workerInstruction: 'w', workerProfile: 'turbo' }],
    ['NUL planSummary', { action: 'answer', planSummary: 'a\0b', finalAnswer: 'a', workerInstruction: null, workerProfile: null }],
    ['extra structured fields', { action: 'answer', planSummary: 's', finalAnswer: 'a', workerInstruction: null, workerProfile: null, reasoning: 'r' }],
    ['model-like arbitrary strings', { action: 'delegate', planSummary: 's', finalAnswer: null, workerInstruction: 'w', workerProfile: 'gpt-4o-mini', provider: 'openai', model: 'x' }],
    ['non-object envelope', [1, 2]],
    ['malformed JSON', '{not json']
  ]

  for (const [name, output] of cases) {
    it(`rejects ${name} with zero follow-up calls`, async () => {
      const harness = openHarness()
      try {
        const sessionId = await seed(harness)
        harness.adapter.nextPlan = typeof output === 'string' ? output : JSON.stringify(output)
        await assert.rejects(
          harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }),
          InvalidBrainPlanError
        )
        assert.equal(harness.adapter.structuredCalls, 1)
        assert.equal(harness.adapter.textCalls, 0)
        // A failed run is persisted for visibility; no assistant message.
        assert.equal(runCount(harness.db), 1)
        assert.equal(harness.adapter.textCalls, 0)
      } finally {
        harness.db.close()
        rmSync(harness.dir, { recursive: true, force: true })
      }
    })
  }

  it('rejects NUL finalAnswer and oversized answer', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.adapter.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 's',
        finalAnswer: 'a\0b',
        workerInstruction: null,
        workerProfile: null
      })
      await assert.rejects(
        harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }),
        InvalidBrainPlanError
      )
      harness.adapter.nextPlan = JSON.stringify({
        action: 'answer',
        planSummary: 's',
        finalAnswer: `${'x'.repeat(64 * 1024)}\n`,
        workerInstruction: null,
        workerProfile: null
      })
      await assert.rejects(
        harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }),
        InvalidBrainPlanError
      )
      assert.equal(harness.adapter.textCalls, 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('rejects bad-Unicode workerInstruction', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.adapter.nextPlan =
        '{"action":"delegate","planSummary":"s","finalAnswer":null,"workerInstruction":"bad \\ud800 end","workerProfile":"coding"}'
      await assert.rejects(
        harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }),
        InvalidBrainPlanError
      )
      assert.equal(harness.adapter.textCalls, 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
