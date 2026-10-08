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
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiCompletionService } from './ai-completion-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import {
  ProposalContextMissingError,
  ProposalNothingToProposeError
} from './ai-proposal-errors'
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

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  structuredCalls = 0

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<{ outputText: string }> {
    this.structuredCalls += 1
    return { outputText: JSON.stringify({ summary: 'ok', proposedContent: 'changed\n' }) }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  otherWorkspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  proposals: AiCodeProposalService
  providerService: AiProviderService
  adapter: FakeAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  void new KeyValueRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-elig-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
  writeFileSync(join(root, 'other.ts'), 'line one\nline two\n')
  const otherRoot = join(dir, 'other-project')
  mkdirSync(otherRoot, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const otherWorkspaceId = workspaces.create({ rootPath: otherRoot, displayName: 'other', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const proposals = new AiCodeProposalService(
    workspaces,
    codingRows,
    providerRows,
    providerService,
    registry,
    files,
    transactions,
    { operationGuard: guard }
  )
  void new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
    operationGuard: guard
  })
  return { db, dir, root, workspaceId, otherWorkspaceId, context, sessions, proposals, providerService, adapter }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

describe('proposal eligibility', () => {
  it('1. exactly one whole-file attachment accepted', async () => {
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
      const before = harness.adapter.structuredCalls
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.structuredCalls, before + 1)
      assert.equal(result.transaction.status, 'pending')
    } finally {
      closeHarness(harness)
    }
  })

  it('2. no context rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('3. manual-note-only rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'just a note' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [note]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('4. excerpt-only rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [excerpt]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('5. search-only rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const match = await harness.context.prepareSearchMatch({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        line: 2
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [match]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('6. two whole files rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'other.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [first, second]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('7. whole-file plus manual notes accepted', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'keep it simple' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Change this.',
        context: [whole, note]
      })
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(result.transaction.status, 'pending')
      assert.equal(harness.adapter.structuredCalls, 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('8. whole-file plus excerpt rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Hi.',
        context: [whole, excerpt]
      })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalContextMissingError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('9. session/workspace mismatch rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.otherWorkspaceId, sessionId: session.id }),
        SessionWorkspaceMismatchError
      )
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: 999999 }),
        SessionNotFoundError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('10. latest assistant message rejected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Change this.',
        context: [whole]
      })
      // Simulate an assistant reply landing after the user message.
      harness.db
        .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .run(session.id, 'assistant', 'done', 9999)
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId: session.id }),
        ProposalNothingToProposeError
      )
      assert.equal(harness.adapter.structuredCalls, 0)
    } finally {
      closeHarness(harness)
    }
  })
})
