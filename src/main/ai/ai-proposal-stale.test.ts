import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { ProposalStaleBeforeProviderError, ProposalStaleDuringProviderError } from './ai-proposal-errors'

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
  structuredCalls = 0
  mutateDuringCall: (() => void) | null = null

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(
    request: ProviderStructuredRequest & { apiKey: string }
  ): Promise<ProviderStructuredResult> {
    this.structuredCalls += 1
    // Simulate the file changing DURING the model request, before the
    // service creates the transaction.
    this.mutateDuringCall?.()
    void request
    return { outputText: JSON.stringify({ summary: 'update title', proposedContent: 'const alpha = 2\nconst beta = 2\nconst gamma = 3\n' }) }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  adapter: FakeAdapter
  providerService: AiProviderService
  codingRows: CodingSessionRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-stale-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const proposals = new AiCodeProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    transactions,
    { operationGuard: new AiOperationGuard() }
  )
  return { db, dir, root, workspaceId, context, sessions, proposals, adapter, providerService, codingRows }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

function transactionCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('proposal stale source', () => {
  it('pre-provider: persisted A, disk B, no provider call, no transaction', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Change this.',
        context: [whole]
      })
      // External change after attach, before proposal.
      writeFileSync(join(harness.root, 'app.ts'), 'const alpha = 999\n')
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        (error: unknown) => {
          assert.ok(error instanceof ProposalStaleBeforeProviderError)
          assert.equal(
            (error as Error).message,
            'This file changed after you attached it. Attach it again before requesting a change.'
          )
          return true
        }
      )
      assert.equal(harness.adapter.structuredCalls, 0)
      assert.equal(transactionCount(harness.db), 0)
      // Disk keeps B; no auto retry happened.
      assert.equal(readFileSync(join(harness.root, 'app.ts'), 'utf8'), 'const alpha = 999\n')
    } finally {
      closeHarness(harness)
    }
  })

  it('post-provider: disk changes during generation, no transaction, B untouched', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Change this.',
        context: [whole]
      })
      // Disk A at proposal start; change to B while the provider runs.
      harness.adapter.mutateDuringCall = () => {
        writeFileSync(join(harness.root, 'app.ts'), 'external B\n')
      }
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        (error: unknown) => {
          assert.ok(error instanceof ProposalStaleDuringProviderError)
          assert.equal(
            (error as Error).message,
            'The file changed while STARK was preparing the proposal. Attach it again and try again.'
          )
          return true
        }
      )
      assert.equal(harness.adapter.structuredCalls, 1)
      assert.equal(transactionCount(harness.db), 0)
      assert.equal(readFileSync(join(harness.root, 'app.ts'), 'utf8'), 'external B\n')
    } finally {
      closeHarness(harness)
    }
  })
})
