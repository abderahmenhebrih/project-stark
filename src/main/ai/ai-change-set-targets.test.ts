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
import { InvalidChangeSetOutputError } from './ai-change-set-errors'

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
  nextOutput = ''
  structuredCalls = 0

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    this.structuredCalls += 1
    return { outputText: this.nextOutput }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiMultiFileProposalService
  providerService: AiProviderService
  adapter: ScriptedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-targets-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'f0.ts'), 'const v0 = 1\n')
  writeFileSync(join(root, 'f1.ts'), 'const v1 = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const adapter = new ScriptedAdapter()
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
  return { db, dir, workspaceId, context, sessions, proposals, providerService, adapter }
}

async function seedTwo(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f0.ts' })
  const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f1.ts' })
  await harness.sessions.sendUserMessage({
    workspaceId: harness.workspaceId,
    sessionId: session.id,
    content: 'Update both.',
    context: [first, second]
  })
  return session.id
}

function setCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('change-set target authority', () => {
  it('unknown target T99 rejects the entire proposal', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedTwo(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'evil',
        changes: [{ targetId: 'T99', summary: 'x', proposedContent: 'pwned\n' }]
      })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        InvalidChangeSetOutputError
      )
      assert.equal(setCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('duplicate target T1 rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedTwo(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'dup',
        changes: [
          { targetId: 'T1', summary: 'a', proposedContent: 'const v0 = 2\n' },
          { targetId: 'T1', summary: 'b', proposedContent: 'const v0 = 3\n' }
        ]
      })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        InvalidChangeSetOutputError
      )
      assert.equal(setCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('valid T1 plus T2 subset accepted', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedTwo(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'both',
        changes: [
          { targetId: 'T1', summary: 'bump 0', proposedContent: 'const v0 = 2\n' },
          { targetId: 'T2', summary: 'bump 1', proposedContent: 'const v1 = 2\n' }
        ]
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 2)
      assert.equal(result.changeSet.items[0]?.transaction.files[0]?.relativePath, 'f0.ts')
      assert.equal(result.changeSet.items[1]?.transaction.files[0]?.relativePath, 'f1.ts')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('model cannot change paths: path-like content has no authority', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedTwo(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'sneaky',
        changes: [
          {
            targetId: 'T1',
            summary: 'bump',
            proposedContent: '// ../../other/evil.ts\nconst v0 = 2\n'
          }
        ]
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      // The path-like comment is inert file text; the transaction still
      // targets the main-owned f0.ts with exactly one file.
      assert.equal(result.changeSet.items.length, 1)
      assert.equal(result.changeSet.items[0]?.transaction.files[0]?.relativePath, 'f0.ts')
      assert.ok(result.changeSet.items[0]?.transaction.files[0]?.proposedContent.includes('../../other/evil.ts'))
      const txCount = harness.db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get() as unknown as Record<string, unknown>
      assert.equal(txCount['n'], 1)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('renderer cannot supply target IDs: request shape is workspace/session only', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedTwo(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'ok',
        changes: [{ targetId: 'T1', summary: 'bump', proposedContent: 'const v0 = 2\n' }]
      })
      for (const bad of [
        { workspaceId: harness.workspaceId, sessionId, targetIds: ['T1'] },
        { workspaceId: harness.workspaceId, sessionId, relativePaths: ['f0.ts'] },
        { workspaceId: harness.workspaceId, sessionId, proposedContent: 'x' }
      ]) {
        await assert.rejects(harness.proposals.proposeChangeSet(bad), Error)
      }
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
