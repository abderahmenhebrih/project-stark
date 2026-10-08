import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { deriveChangeSetStatus } from '../change-sets/change-set-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiMultiFileProposalService } from './ai-multi-file-proposal-service'
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

const BEFORE = { a: 'const a = 1\n', b: 'const b = 1\n', c: 'const c = 1\n' } as const
const AFTER = { a: 'const a = 2\n', b: 'const b = 2\n', c: 'const c = 2\n' } as const

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
    return {
      outputText: JSON.stringify({
        summary: 'bump all three',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: AFTER.a },
          { targetId: 'T2', summary: 'bump b', proposedContent: AFTER.b },
          { targetId: 'T3', summary: 'bump c', proposedContent: AFTER.c }
        ]
      })
    }
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
  proposals: AiMultiFileProposalService
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-tx-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), BEFORE.a)
  writeFileSync(join(root, 'b.ts'), BEFORE.b)
  writeFileSync(join(root, 'c.ts'), BEFORE.c)
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const proposals = new AiMultiFileProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    changeSets,
    { operationGuard: new AiOperationGuard() }
  )
  return { db, dir, root, workspaceId, context, sessions, transactions, proposals, providerService }
}

describe('change-set transaction integration', () => {
  it('successful proposal leaves all files byte-identical with pending children', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const drafts = []
      for (const name of ['a.ts', 'b.ts', 'c.ts']) {
        drafts.push(await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: name }))
      }
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump all.',
        context: drafts
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(result.changeSet.items.length, 3)
      for (const item of result.changeSet.items) {
        assert.equal(item.transaction.status, 'pending')
      }
      assert.equal(readFileSync(join(harness.root, 'a.ts'), 'utf8'), BEFORE.a)
      assert.equal(readFileSync(join(harness.root, 'b.ts'), 'utf8'), BEFORE.b)
      assert.equal(readFileSync(join(harness.root, 'c.ts'), 'utf8'), BEFORE.c)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('accept A, reject B, leave C pending: partial resolution, no other file mutated', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const drafts = []
      for (const name of ['a.ts', 'b.ts', 'c.ts']) {
        drafts.push(await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: name }))
      }
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump all.',
        context: drafts
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id })
      const byPath = new Map(result.changeSet.items.map((item) => [item.transaction.files[0]?.relativePath, item.transaction.id]))
      const idA = byPath.get('a.ts')
      const idB = byPath.get('b.ts')
      const idC = byPath.get('c.ts')
      assert.ok(idA !== undefined && idB !== undefined && idC !== undefined)
      // Only the human Accept touches disk, and only that one file.
      const accepted = await harness.transactions.acceptTransaction({ transactionId: idA })
      assert.equal(accepted.status, 'applied')
      const rejected = await harness.transactions.rejectTransaction({ transactionId: idB })
      assert.equal(rejected.status, 'rejected')
      assert.equal(readFileSync(join(harness.root, 'a.ts'), 'utf8'), AFTER.a)
      assert.equal(readFileSync(join(harness.root, 'b.ts'), 'utf8'), BEFORE.b)
      assert.equal(readFileSync(join(harness.root, 'c.ts'), 'utf8'), BEFORE.c)
      const statuses = ['applied', 'rejected', 'pending'] as const
      assert.equal(deriveChangeSetStatus(statuses), 'partially_resolved')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
