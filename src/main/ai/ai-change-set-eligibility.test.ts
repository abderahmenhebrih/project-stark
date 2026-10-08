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
import { ChangeSetContextMissingError, ChangeSetNothingToProposeError } from './ai-change-set-errors'
import { SessionNotFoundError, SessionWorkspaceMismatchError } from '../sessions/errors'

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

export class FakeSetAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  structuredCalls = 0
  nextOutput: string | null = null

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    this.structuredCalls += 1
    if (this.nextOutput !== null) {
      return { outputText: this.nextOutput }
    }
    return {
      outputText: JSON.stringify({
        summary: 'grouped update',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: 'const a = 2\n' },
          { targetId: 'T2', summary: 'bump b', proposedContent: 'const b = 2\n' }
        ]
      })
    }
  }
}

export function openSetHarness(fileCount = 3): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  otherWorkspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiMultiFileProposalService
  providerService: AiProviderService
  adapter: FakeSetAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-elig-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  for (let index = 0; index < 6; index += 1) {
    writeFileSync(join(root, `f${String(index)}.ts`), `const v${String(index)} = 1\n`)
  }
  const otherRoot = join(dir, 'other-project')
  mkdirSync(otherRoot, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const otherWorkspaceId = workspaces.create({ rootPath: otherRoot, displayName: 'other', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const changeSets = new ChangeSetService(workspaces, setRows, changeRows)
  const adapter = new FakeSetAdapter()
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
  void fileCount
  return { db, dir, root, workspaceId, otherWorkspaceId, context, sessions, proposals, providerService, adapter }
}

export function closeSetHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

export async function seedWholeFiles(
  harness: ReturnType<typeof openSetHarness>,
  relativePaths: readonly string[],
  withNote = false
): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const drafts = []
  for (const relativePath of relativePaths) {
    drafts.push(await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath }))
  }
  if (withNote) {
    drafts.push(await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'keep it tidy' }))
  }
  await harness.sessions.sendUserMessage({
    workspaceId: harness.workspaceId,
    sessionId: session.id,
    content: 'Update these.',
    context: drafts
  })
  return session.id
}

describe('change-set eligibility', () => {
  it('1 file routes to single-file Stage 16, not the Change Set path', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts'])
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        ChangeSetContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('2 files accepted', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts', 'f1.ts'])
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 2)
      assert.equal(harness.adapter.structuredCalls, 1)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('5 files accepted', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'])
      harness.adapter.nextOutput = JSON.stringify({
        summary: 'five',
        changes: ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'].map((name, index) => ({
          targetId: `T${String(index + 1)}`,
          summary: `bump ${name}`,
          proposedContent: `const v${String(index)} = 2\n`
        }))
      })
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 5)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('6 files rejected', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'])
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        ChangeSetContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('notes plus files accepted', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts', 'f1.ts'], true)
      const result = await harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.equal(result.changeSet.items.length, 2)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('excerpt mixed in rejected', async () => {
    const harness = openSetHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f0.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f1.ts' })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'f2.ts',
        lineStart: 1,
        lineEnd: 1
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [first, second, excerpt]
      })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ChangeSetContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('search mixed in rejected', async () => {
    const harness = openSetHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f0.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'f1.ts' })
      const match = await harness.context.prepareSearchMatch({
        workspaceId: harness.workspaceId,
        relativePath: 'f2.ts',
        line: 1
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [first, second, match]
      })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ChangeSetContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('zero files rejected', async () => {
    const harness = openSetHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ChangeSetContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('workspace mismatch rejected', async () => {
    const harness = openSetHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.otherWorkspaceId, sessionId: session.id }),
        SessionWorkspaceMismatchError
      )
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId: 999999 }),
        SessionNotFoundError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })

  it('latest assistant message rejected', async () => {
    const harness = openSetHarness()
    try {
      const sessionId = await seedWholeFiles(harness, ['f0.ts', 'f1.ts'])
      harness.db
        .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, 'assistant', 'done', 9999)
      await assert.rejects(
        harness.proposals.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        ChangeSetNothingToProposeError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeSetHarness(harness)
    }
  })
})
