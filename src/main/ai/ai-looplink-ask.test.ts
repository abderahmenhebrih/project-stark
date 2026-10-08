import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiCompletionService } from './ai-completion-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
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

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  seen: string[] = []
  failNext = false
  nextText = 'assistant reply'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    const body = request.messages.map((entry) => entry.content).join('\n')
    this.seen.push(body)
    if (this.failNext) {
      this.failNext = false
      throw new Error('provider boom')
    }
    return { text: this.nextText }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  context: SessionContextService
  completion: AiCompletionService
  providerService: AiProviderService
  looplinks: LooplinkRepository
  loopService: LooplinkService
  adapter: FakeAdapter
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-loop-ask-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const looplinks = new LooplinkRepository(db)
  const loopService = new LooplinkService(
    workspaces,
    codingRows,
    looplinks,
    guard,
    runs,
    setRows,
    changeRows
  )
  const completion = new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
    operationGuard: guard,
    looplink: { service: loopService, store: looplinks }
  })
  return { db, dir, workspaceId, sessions, codingRows, context, completion, providerService, looplinks, loopService, adapter }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

describe('ask continuity', () => {
  it('target Ask includes the historical block and consumes atomically', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        content: 'What is alpha?',
        context: [whole]
      })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue and explain the next step.'
      })
      const result = await harness.completion.generateResponse({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id
      })
      assert.equal(result.message.role, 'assistant')
      const sent = harness.adapter.seen[0] ?? ''
      assert.ok(sent.includes('Continue and explain the next step.'), 'target request travels')
      assert.ok(sent.includes('[LOOPLINK CONTINUITY'), 'historical block travels')
      assert.ok(sent.includes('What is alpha?'), 'source history travels')
      assert.ok(!sent.includes('stark:ai:'), 'no hidden channel data')
      // Atomic: assistant persisted and handoff consumed.
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'consumed')
      // Second Ask carries no block.
      harness.adapter.nextText = 'second reply'
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Follow-up.'
      })
      await harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.ok(!((harness.adapter.seen[1] ?? '').includes('[LOOPLINK CONTINUITY')))
    } finally {
      closeHarness(harness)
    }
  })

  it('provider failure leaves no assistant with Looplink still pending', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id,
        content: 'Continue.'
      })
      harness.adapter.failNext = true
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }),
        Error
      )
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'pending')
      assert.equal(harness.codingRows.listMessagesNewestFirst(created.targetSession.id, 10, null).length, 1)
      // Explicit retry succeeds and consumes exactly once.
      const result = await harness.completion.generateResponse({
        workspaceId: harness.workspaceId,
        sessionId: created.targetSession.id
      })
      assert.equal(result.message.content, 'assistant reply')
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'consumed')
    } finally {
      closeHarness(harness)
    }
  })

  it('completion fault leaves no assistant and Looplink pending', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const created = await harness.loopService.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.throws(
        () =>
          harness.looplinks.appendAssistantMessageAndConsume(
            { sessionId: created.targetSession.id, content: 'x', now: 9999, looplinkId: created.looplink.id, retitle: null },
            { failAfterMessage: true }
          ),
        Error
      )
      assert.equal(harness.codingRows.listMessagesNewestFirst(created.targetSession.id, 10, null).length, 0)
      assert.equal(harness.looplinks.findById(created.looplink.id)?.status, 'pending')
    } finally {
      closeHarness(harness)
    }
  })
})
