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
import { ChangeSetService } from '../change-sets/change-set-service'
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
import { ChangeSetStaleBeforeProviderError, ChangeSetStaleDuringProviderError } from './ai-change-set-errors'

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

  async generateStructured(): Promise<ProviderStructuredResult> {
    this.structuredCalls += 1
    this.mutateDuringCall?.()
    return {
      outputText: JSON.stringify({
        summary: 'grouped',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: 'const a = 2\n' },
          { targetId: 'T2', summary: 'bump b', proposedContent: 'const b = 2\n' }
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
  proposals: AiMultiFileProposalService
  providerService: AiProviderService
  adapter: FakeAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-stale-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'const b = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
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
  return { db, dir, root, workspaceId, context, sessions, proposals, providerService, adapter }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

function countTable(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('change-set stale protection', () => {
  it('pre-provider: B changes, zero provider calls, zero sets, zero transactions', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'a.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'b.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Update both.',
        context: [first, second]
      })
      writeFileSync(join(harness.root, 'b.ts'), 'const b = 999\n')
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id }),
        (error: unknown) => {
          assert.ok(error instanceof ChangeSetStaleBeforeProviderError)
          assert.equal(
            (error as Error).message,
            'One of the attached files changed after you attached it. Attach the changed files again before requesting a proposal.'
          )
          return true
        }
      )
      assert.equal(harness.adapter.structuredCalls, 0)
      assert.equal(countTable(harness.db, 'change_sets'), 0)
      assert.equal(countTable(harness.db, 'change_set_items'), 0)
      assert.equal(countTable(harness.db, 'change_transactions'), 0)
      assert.equal(countTable(harness.db, 'change_transaction_files'), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('during-provider: one proposed target changes, zero sets, zero transactions, external change preserved', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'a.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'b.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Update both.',
        context: [first, second]
      })
      harness.adapter.mutateDuringCall = () => {
        writeFileSync(join(harness.root, 'a.ts'), 'external change\n')
      }
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id }),
        (error: unknown) => {
          assert.ok(error instanceof ChangeSetStaleDuringProviderError)
          assert.equal(
            (error as Error).message,
            'One of the files changed while STARK was preparing the proposal. Attach it again and try again.'
          )
          return true
        }
      )
      assert.equal(harness.adapter.structuredCalls, 1)
      assert.equal(countTable(harness.db, 'change_sets'), 0)
      assert.equal(countTable(harness.db, 'change_set_items'), 0)
      assert.equal(countTable(harness.db, 'change_transactions'), 0)
      assert.equal(countTable(harness.db, 'change_transaction_files'), 0)
      assert.equal(readFileSync(join(harness.root, 'a.ts'), 'utf8'), 'external change\n')
    } finally {
      closeHarness(harness)
    }
  })
})
