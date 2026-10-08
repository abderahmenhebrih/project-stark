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
import { ChangeSetTooLargeError, InvalidChangeSetOutputError } from './ai-change-set-errors'
import { MAX_AI_PROPOSED_FILE_BYTES } from './limits'

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

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    return { outputText: this.nextOutput }
  }
}

const NAMES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']

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
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-limits-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  for (const name of NAMES) {
    writeFileSync(join(root, name), 'x\n')
  }
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

async function seedFive(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const drafts = []
  for (const name of NAMES) {
    drafts.push(await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: name }))
  }
  await harness.sessions.sendUserMessage({
    workspaceId: harness.workspaceId,
    sessionId: session.id,
    content: 'Update all.',
    context: drafts
  })
  return session.id
}

function setCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

function sizedContent(bytes: number): string {
  return `${'x'.repeat(bytes - 1)}\n`
}

describe('change-set output limits', () => {
  it('per-file at exactly 64 KiB accepted', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedFive(harness)
      const atLimit = sizedContent(MAX_AI_PROPOSED_FILE_BYTES)
      assert.equal(Buffer.from(atLimit, 'utf8').byteLength, MAX_AI_PROPOSED_FILE_BYTES)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'boundary',
        changes: [{ targetId: 'T1', summary: 'big but bounded', proposedContent: atLimit }]
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 1)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('per-file over 64 KiB rejected without truncation', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedFive(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'too big',
        changes: [{ targetId: 'T1', summary: 'oversize', proposedContent: sizedContent(MAX_AI_PROPOSED_FILE_BYTES + 1) }]
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

  it('total under 256 KiB across five files accepted', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedFive(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'five medium files',
        changes: NAMES.map((name, index) => ({
          targetId: `T${String(index + 1)}`,
          summary: `update ${name}`,
          proposedContent: sizedContent(50_000)
        }))
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 5)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('total over 256 KiB rejected without truncation', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedFive(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'five large files',
        changes: NAMES.map((name, index) => ({
          targetId: `T${String(index + 1)}`,
          summary: `update ${name}`,
          proposedContent: sizedContent(60_000)
        }))
      })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        ChangeSetTooLargeError
      )
      assert.equal(setCount(harness.db), 0)
      const txCount = harness.db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get() as unknown as Record<string, unknown>
      assert.equal(txCount['n'], 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
