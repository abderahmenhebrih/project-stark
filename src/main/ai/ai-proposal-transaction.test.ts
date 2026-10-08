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

const BEFORE_A = 'export const title = "OLD"\n'
const PROPOSED_B = 'export const title = "STARK_STAGE16_OK"\n'

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    return { outputText: JSON.stringify({ summary: 'Change the exported title string', proposedContent: PROPOSED_B }) }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  transactions: ChangeTransactionService
  proposals: AiCodeProposalService
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-tx-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'title.ts'), BEFORE_A)
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
  return { db, dir, root, workspaceId, context, sessions, transactions, proposals, providerService }
}

describe('proposal transaction integration', () => {
  it('proposal creates pending tx, disk stays A, accept writes B', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'title.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: "Change the exported title string to 'STARK_STAGE16_OK'.",
        context: [whole]
      })
      // 1-4: disk A, attach A, provider proposes B, success.
      assert.equal(readFileSync(join(harness.root, 'title.ts'), 'utf8'), BEFORE_A)
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id })
      // 5: disk STILL A.
      assert.equal(readFileSync(join(harness.root, 'title.ts'), 'utf8'), BEFORE_A)
      // 6-9: pending tx, before A, proposed B.
      assert.equal(result.transaction.status, 'pending')
      assert.equal(result.transaction.files.length, 1)
      assert.equal(result.transaction.files[0]?.relativePath, 'title.ts')
      assert.equal(result.transaction.files[0]?.beforeContent, BEFORE_A)
      assert.equal(result.transaction.files[0]?.proposedContent, PROPOSED_B)
      // 10-11: human Accept via the EXISTING service writes B.
      const accepted = await harness.transactions.acceptTransaction({ transactionId: result.transaction.id })
      assert.equal(accepted.status, 'applied')
      assert.equal(readFileSync(join(harness.root, 'title.ts'), 'utf8'), PROPOSED_B)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('reject leaves disk at A', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'title.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Propose a title change.',
        context: [whole]
      })
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(result.transaction.status, 'pending')
      const rejected = await harness.transactions.rejectTransaction({ transactionId: result.transaction.id })
      assert.equal(rejected.status, 'rejected')
      assert.equal(readFileSync(join(harness.root, 'title.ts'), 'utf8'), BEFORE_A)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
