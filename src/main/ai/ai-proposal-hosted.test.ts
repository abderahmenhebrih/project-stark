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
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiMultiFileProposalService } from './ai-multi-file-proposal-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderModelUnavailableError } from './errors'
import type {
  AiProviderAdapter,
  HostedSessionProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

/**
 * Hosted proposal proof (no network, no Supabase, no keys, no BYOK
 * credential). Both single-file and grouped proposals route an
 * explicit `builtin:*` selection through the stark adapter with the
 * session token; legacy payloads keep persisted-BYOK behavior.
 */

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

class StarkCapturingAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  seen: (ProviderStructuredRequest & { apiKey: string })[] = []

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'builtin:gpt-5.6-luna' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(
    request: ProviderStructuredRequest & { apiKey: string }
  ): Promise<ProviderStructuredResult> {
    this.seen.push(request)
    return { outputText: JSON.stringify({ summary: 's', proposedContent: 'const alpha = 2\n' }) }
  }
}

function hostedSession(): HostedSessionProvider {
  return {
    getAccessToken: async (): Promise<string> => 'ACCESS-MARKER'
  }
}

function openSingle(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  adapter: StarkCapturingAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-hosted-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new StarkCapturingAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: hostedSession()
  })
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
  return { db, dir, workspaceId, context, sessions, proposals, adapter }
}

describe('hosted single-file proposal', () => {
  it('reaches Review through stark with the session token and no BYOK key', async () => {
    const harness = openSingle()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump alpha.',
        context: [whole]
      })
      const result = await harness.proposals.proposeFileChange({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        model: 'builtin:gpt-5.6-luna'
      })
      assert.equal(harness.adapter.seen.length, 1)
      assert.equal(harness.adapter.seen[0]?.apiKey, 'ACCESS-MARKER')
      assert.equal(harness.adapter.seen[0]?.model, 'builtin:gpt-5.6-luna')
      assert.equal(result.transaction.status, 'pending')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown builtin ids before any provider call', async () => {
    const harness = openSingle()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump alpha.',
        context: [whole]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          model: 'builtin:evil'
        }),
        ProviderModelUnavailableError
      )
      assert.equal(harness.adapter.seen.length, 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})

class StarkGroupAdapter extends StarkCapturingAdapter {
  override async generateStructured(
    request: ProviderStructuredRequest & { apiKey: string }
  ): Promise<ProviderStructuredResult> {
    this.seen.push(request)
    return {
      outputText: JSON.stringify({
        summary: 'grouped update',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: 'const v0 = 2\n' },
          { targetId: 'T2', summary: 'bump b', proposedContent: 'const v1 = 2\n' }
        ]
      })
    }
  }
}

function openGrouped(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiMultiFileProposalService
  adapter: StarkGroupAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-hosted-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'f0.ts'), 'const v0 = 1\n')
  writeFileSync(join(root, 'f1.ts'), 'const v1 = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const adapter = new StarkGroupAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: hostedSession()
  })
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
  return { db, dir, workspaceId, context, sessions, proposals, adapter }
}

describe('hosted grouped proposal', () => {
  it('creates a pending Change Set through stark with the session token', async () => {
    const harness = openGrouped()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f0.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f1.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Bump both.',
        context: [first, second]
      })
      const result = await harness.proposals.proposeChangeSet({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        model: 'builtin:gpt-5.6-luna'
      })
      assert.equal(harness.adapter.seen.length, 1)
      assert.equal(harness.adapter.seen[0]?.apiKey, 'ACCESS-MARKER')
      assert.equal(harness.adapter.seen[0]?.model, 'builtin:gpt-5.6-luna')
      assert.ok(result.changeSet.id > 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
