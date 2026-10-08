import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiCompletionService } from './ai-completion-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
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

class CountingAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  textCalls = 0
  structuredCalls = 0
  failNext = false
  nextProposed: string | null = null

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.textCalls += 1
    void request
    if (this.failNext) {
      throw new Error('provider boom')
    }
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    this.structuredCalls += 1
    if (this.failNext) {
      throw new Error('provider boom')
    }
    return { outputText: JSON.stringify({ summary: 's', proposedContent: this.nextProposed ?? 'const a = 2\n' }) }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  completion: AiCompletionService
  guard: AiOperationGuard
  adapter: CountingAdapter
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-lock-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new CountingAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const proposals = new AiCodeProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    transactions,
    { operationGuard: guard }
  )
  const completion = new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
    operationGuard: guard
  })
  return { db, dir, workspaceId, context, sessions, proposals, completion, guard, adapter, providerService }
}

async function seedSession(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
  await harness.sessions.sendUserMessage({
    workspaceId: harness.workspaceId,
    sessionId: session.id,
    content: 'Change it.',
    context: [whole]
  })
  return session.id
}

describe('proposal in-flight protection', () => {
  it('second proposal while one holds the session lock is rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      harness.guard.acquire(sessionId)
      try {
        await assert.rejects(
          harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        assert.equal(harness.adapter.structuredCalls, 0)
      } finally {
        harness.guard.release(sessionId)
      }
      // Lock cleared: the retry now succeeds.
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.transaction.status, 'pending')
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('proposal while a normal generation holds the lock is rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      harness.guard.acquire(sessionId)
      try {
        await assert.rejects(
          harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        assert.equal(harness.adapter.structuredCalls, 0)
      } finally {
        harness.guard.release(sessionId)
      }
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('normal generation while a proposal holds the lock is rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      harness.guard.acquire(sessionId)
      try {
        await assert.rejects(
          harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId }),
          GenerationInFlightError
        )
        assert.equal(harness.adapter.textCalls, 0)
      } finally {
        harness.guard.release(sessionId)
      }
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('locks clear on success', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('locks clear on provider failure', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      harness.adapter.failNext = true
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        /We couldn’t prepare this code proposal\.|provider boom/
      )
      assert.equal(harness.guard.isActive(sessionId), false)
      harness.adapter.failNext = false
      // Not stuck: a later attempt proceeds.
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.transaction.status, 'pending')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('locks clear on transaction failure', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedSession(harness)
      // No-op proposal: provider succeeds but no transaction is created.
      harness.adapter.nextProposed = 'const a = 1\n'
      const { ProposalNoChangesError } = await import('./ai-proposal-errors')
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        ProposalNoChangesError
      )
      assert.equal(harness.guard.isActive(sessionId), false)
      // Not stuck: a real change now proceeds.
      harness.adapter.nextProposed = null
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.transaction.status, 'pending')
      assert.equal(harness.guard.isActive(sessionId), false)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('no deadlock: guard release is idempotent', () => {
    const guard = new AiOperationGuard()
    guard.acquire(7)
    assert.equal(guard.isActive(7), true)
    assert.throws(() => guard.acquire(7), GenerationInFlightError)
    guard.release(7)
    assert.equal(guard.isActive(7), false)
    guard.release(7)
    assert.equal(guard.isActive(7), false)
  })
})
