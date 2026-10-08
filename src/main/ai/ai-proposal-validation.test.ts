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
import { InvalidProposalOutputError, ProposalNoChangesError, ProposalTooLargeError } from './ai-proposal-errors'
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
  nextOutput: string = JSON.stringify({ summary: 'ok', proposedContent: 'changed\n' })

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

const BASE_CONTENT = 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n'

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessionId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  adapter: ScriptedAdapter
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-valid-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), BASE_CONTENT)
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new ScriptedAdapter()
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
  return { db, dir, workspaceId, sessionId: 0, context, sessions, proposals, adapter, providerService }
}

async function seedUserWithWholeFile(harness: ReturnType<typeof openHarness>): Promise<number> {
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
  return session.id
}

function transactionCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('proposal output validation', () => {
  it('valid result creates a pending transaction', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: 'bump alpha', proposedContent: 'const alpha = 2\nconst beta = 2\nconst gamma = 3\n' })
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.transaction.status, 'pending')
      assert.equal(result.summary, 'bump alpha')
      assert.equal(transactionCount(harness.db), 1)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('missing summary rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ proposedContent: 'x\n' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('empty summary rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: '   ', proposedContent: 'x\n' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('overlong summary rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: 's'.repeat(501), proposedContent: 'x\n' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('missing proposedContent rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: 'ok' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('NUL proposedContent rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: 'ok', proposedContent: 'a\0b' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('malformed Unicode rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      // Lone high surrogate encoded via escape so JSON parses but JS holds an unpaired unit.
      harness.adapter.nextOutput = JSON.stringify({ summary: 'ok', proposedContent: 'lone surrogate: �' }).replace('�', '\\ud800')
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('over-64KiB proposedContent rejected without truncation', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      const big = `x`.repeat(MAX_AI_PROPOSED_FILE_BYTES + 1)
      harness.adapter.nextOutput = JSON.stringify({ summary: 'big', proposedContent: big })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        ProposalTooLargeError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('identical no-op proposal creates nothing', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({ summary: 'no change', proposedContent: BASE_CONTENT })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        ProposalNoChangesError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('hostile markup remains inert text', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>'
      harness.adapter.nextOutput = JSON.stringify({ summary: hostile, proposedContent: `${BASE_CONTENT}// ${hostile}\n` })
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.summary, hostile)
      assert.ok(result.transaction.files[0]?.proposedContent.includes(hostile))
      assert.equal(typeof result.summary, 'string')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('extra unexpected fields rejected', async () => {
    const harness = openHarness()
    try {
      const sessionId = await seedUserWithWholeFile(harness)
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'ok',
        proposedContent: 'x\n',
        relativePath: '../../evil.ts',
        command: 'rm -rf /',
        revision: '0'.repeat(64)
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        InvalidProposalOutputError
      )
      assert.equal(transactionCount(harness.db), 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
