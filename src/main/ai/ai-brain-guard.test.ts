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
import { AiCompletionService } from './ai-completion-service'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiMultiFileProposalService } from './ai-multi-file-proposal-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
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
import { GenerationInFlightError } from './errors'

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
  structuredCalls = 0
  textCalls = 0
  failStructured = false

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    this.textCalls += 1
    return { text: 'reply' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.structuredCalls += 1
    if (this.failStructured) {
      throw new Error('provider boom')
    }
    return {
      outputText: JSON.stringify({ action: 'answer', planSummary: 'Direct.', finalAnswer: 'DIRECT_OK', workerInstruction: null, workerProfile: null })
    }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  completion: AiCompletionService
  single: AiCodeProposalService
  multi: AiMultiFileProposalService
  guard: AiOperationGuard
  providerService: AiProviderService
  adapter: AnswerAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const runs = new OrchestrationRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-guard-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new AnswerAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  return {
    db,
    dir,
    workspaceId,
    sessions,
    brain: new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
      operationGuard: guard
    }),
    completion: new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
      operationGuard: guard
    }),
    single: new AiCodeProposalService(workspaces, codingRows, providerRows, providerService, registry, files, transactions, {
      operationGuard: guard
    }),
    multi: new AiMultiFileProposalService(workspaces, codingRows, providerRows, providerService, registry, files, changeSets, {
      operationGuard: guard
    }),
    guard,
    providerService,
    adapter
  }
}

async function seed(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
  return session.id
}

describe('brain operation guard', () => {
  it('while Work holds the lock, Ask/single/multi are rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.guard.acquire(sessionId)
      try {
        await assert.rejects(
          harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        await assert.rejects(
          harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        await assert.rejects(
          harness.single.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        await assert.rejects(
          harness.multi.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        assert.equal(harness.adapter.structuredCalls, 0)
        assert.equal(harness.adapter.textCalls, 0)
      } finally {
        harness.guard.release(sessionId)
      }
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('lock releases after success', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('lock releases after Brain plan failure', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seed(harness)
      harness.adapter.failStructured = true
      await assert.rejects(harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId }), Error)
      assert.equal(harness.guard.isActive(sessionId), false)
      harness.adapter.failStructured = false
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('no deadlock: release is idempotent and per-session', () => {
    const guard = new AiOperationGuard()
    guard.acquire(1)
    assert.throws(() => guard.acquire(1), GenerationInFlightError)
    guard.acquire(2)
    guard.release(1)
    assert.equal(guard.isActive(1), false)
    assert.equal(guard.isActive(2), true)
    guard.release(2)
    guard.release(2)
    assert.equal(guard.isActive(2), false)
  })
})
