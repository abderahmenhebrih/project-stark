import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { isValidRevision } from '../workspace-files/file-revision'
import { SessionContextService } from './session-context-service'
import {
  InvalidContextRequestError,
  StaleContextError,
  STALE_CONTEXT_MESSAGE,
  toPublicContextError
} from './errors'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiProviderService } from '../ai/ai-provider-service'
import { NothingToAnswerError } from '../ai/errors'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import type { FileSessionContextDraft } from '../../shared/context/types'

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
  seen: (ProviderGenerateRequest & { apiKey: string })[] = []
  nextText = 'real assistant reply'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.seen.push(request)
    return { text: this.nextText }
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  completion: AiCompletionService
  adapter: FakeAdapter
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-stale-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
  writeFileSync(join(root, 'other.ts'), 'line one\nline two\nline three\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const completion = new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry)
  return { db, dir, root, workspaceId, context, sessions, codingRows, completion, adapter, providerService }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

function sourceRevisionOf(draft: unknown): string {
  const record = draft as Record<string, unknown>
  const revision = record['sourceRevision']
  assert.equal(typeof revision, 'string')
  return revision as string
}

function messageCount(harness: ReturnType<typeof openHarness>, sessionId: number): number {
  return harness.codingRows.listMessagesNewestFirst(sessionId, 100, null).length
}

function contextRowCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM message_context_items').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('stage 15B stale-context protection', () => {
  it('1. whole-file prepare returns correct revision', async () => {
    const harness = openHarness()
    try {
      const draft = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const expected = sha256Hex(readFileSync(join(harness.root, 'app.ts')))
      assert.equal(sourceRevisionOf(draft), expected)
      assert.ok(isValidRevision(sourceRevisionOf(draft)))
      assert.match(sourceRevisionOf(draft), /^[0-9a-f]{64}$/)
    } finally {
      closeHarness(harness)
    }
  })

  it('2. excerpt prepare returns correct revision', async () => {
    const harness = openHarness()
    try {
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 2
      })
      const expected = sha256Hex(readFileSync(join(harness.root, 'app.ts')))
      assert.equal(sourceRevisionOf(draft), expected)
      assert.ok(isValidRevision(sourceRevisionOf(draft)))
    } finally {
      closeHarness(harness)
    }
  })

  it('3. search-match prepare returns correct revision', async () => {
    const harness = openHarness()
    try {
      const draft = await harness.context.prepareSearchMatch({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        line: 2
      })
      const expected = sha256Hex(readFileSync(join(harness.root, 'app.ts')))
      assert.equal(sourceRevisionOf(draft), expected)
      assert.ok(isValidRevision(sourceRevisionOf(draft)))
    } finally {
      closeHarness(harness)
    }
  })

  it('4. unchanged file between prepare/send succeeds', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 2
      })
      const result = await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Review this.',
        context: [excerpt]
      })
      assert.equal(result.message.content, 'Review this.')
      assert.equal(result.context?.length, 1)
      assert.equal(result.context?.[0]?.content, 'const alpha = 1\nconst beta = 2')
      assert.equal(messageCount(harness, session.id), 1)
      assert.equal(contextRowCount(harness.db), 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('5. whole-file changed before send rejects stale', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      writeFileSync(join(harness.root, 'app.ts'), 'const changed = 99\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Review this.',
          context: [draft]
        }),
        StaleContextError
      )
      await assert.rejects(
        harness.context.resolveAttachmentsForSend(harness.workspaceId, [draft], 2000),
        (error: unknown) => {
          assert.ok(error instanceof StaleContextError)
          assert.equal((error as Error).message, STALE_CONTEXT_MESSAGE)
          assert.equal(
            toPublicContextError('send', error).message,
            'This attached context changed on disk. Reattach it before sending.'
          )
          return true
        }
      )
    } finally {
      closeHarness(harness)
    }
  })

  it('6. excerpt file changed before send rejects stale', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      writeFileSync(join(harness.root, 'app.ts'), 'const alpha = 100\nconst beta = 2\nconst gamma = 3\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Explain.',
          context: [draft]
        }),
        StaleContextError
      )
    } finally {
      closeHarness(harness)
    }
  })

  it('7. search source changed before send rejects stale', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareSearchMatch({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        line: 2
      })
      writeFileSync(join(harness.root, 'app.ts'), 'totally different\ncontent here\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'What is here?',
          context: [draft]
        }),
        StaleContextError
      )
    } finally {
      closeHarness(harness)
    }
  })

  it('8. stale send inserts NO message', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      writeFileSync(join(harness.root, 'app.ts'), 'changed\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Hello.',
          context: [draft]
        }),
        StaleContextError
      )
      assert.equal(messageCount(harness, session.id), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('9. stale send inserts NO message_context_items', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 2
      })
      assert.equal(contextRowCount(harness.db), 0)
      writeFileSync(join(harness.root, 'app.ts'), 'changed\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Hello.',
          context: [draft]
        }),
        StaleContextError
      )
      assert.equal(contextRowCount(harness.db), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('10. stale send performs NO provider generation', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      writeFileSync(join(harness.root, 'app.ts'), 'changed content\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Explain.',
          context: [draft]
        }),
        StaleContextError
      )
      assert.equal(harness.adapter.seen.length, 0)
      // No user message persisted, so there is nothing to answer.
      await assert.rejects(harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId: session.id }), NothingToAnswerError)
      assert.equal(harness.adapter.seen.length, 0)
      assert.equal(messageCount(harness, session.id), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('11. composer/drafts preserved after stale failure', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 2
      })
      const snapshot = JSON.parse(JSON.stringify([draft])) as unknown[]
      writeFileSync(join(harness.root, 'app.ts'), 'changed\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'kept composer text',
          context: [draft]
        }),
        StaleContextError
      )
      // Main never mutates the caller drafts: the renderer still holds
      // the chips and composer text for an explicit reattach.
      assert.deepEqual([draft], snapshot)
      // Explicit reattach with the new revision succeeds.
      const fresh = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      assert.notEqual(sourceRevisionOf(fresh), sourceRevisionOf(draft))
      const retry = await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'kept composer text',
        context: [fresh]
      })
      assert.equal(retry.message.content, 'kept composer text')
      assert.equal(retry.context?.[0]?.content, 'changed')
    } finally {
      closeHarness(harness)
    }
  })

  it('12. no automatic refresh/replacement', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const reviewed = (draft as FileSessionContextDraft).content
      assert.equal(reviewed, 'const alpha = 1')
      writeFileSync(join(harness.root, 'app.ts'), 'const alpha = 999\nconst beta = 2\nconst gamma = 3\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Go.',
          context: [draft]
        }),
        StaleContextError
      )
      // Nothing was persisted — neither the reviewed snapshot nor the
      // new disk content leaked into storage via an auto-refresh.
      assert.equal(messageCount(harness, session.id), 0)
      assert.equal(contextRowCount(harness.db), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('13. manual-note-only send remains unaffected', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'Remember the budget.' })
      assert.ok(!('sourceRevision' in (note as unknown as Record<string, unknown>)))
      // Even though an unrelated file changed on disk, notes carry no
      // revision and must still send.
      writeFileSync(join(harness.root, 'app.ts'), 'unrelated change\n')
      const result = await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Note only.',
        context: [note]
      })
      assert.equal(result.context?.length, 1)
      assert.equal(result.context?.[0]?.kind, 'manual-note')
      assert.equal(result.context?.[0]?.content, 'Remember the budget.')
    } finally {
      closeHarness(harness)
    }
  })

  it('14. multiple attachments: one stale rejects the entire send atomically', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const first = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const second = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'other.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'note' })
      writeFileSync(join(harness.root, 'other.ts'), 'CHANGED\n')
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Mixed.',
          context: [first, second, note]
        }),
        StaleContextError
      )
      assert.equal(messageCount(harness, session.id), 0)
      assert.equal(contextRowCount(harness.db), 0)
      assert.equal(harness.adapter.seen.length, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('15. revision malformed/forged fails validation', async () => {
    const harness = openHarness()
    try {
      const good = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const base = good as unknown as Record<string, unknown>
      const malformed: unknown[] = [
        { ...base, sourceRevision: undefined },
        { ...base, sourceRevision: '' },
        { ...base, sourceRevision: 'xyz' },
        { ...base, sourceRevision: (base['sourceRevision'] as string).slice(0, 63) },
        { ...base, sourceRevision: `${String(base['sourceRevision'])}0` },
        { ...base, sourceRevision: (base['sourceRevision'] as string).toUpperCase() },
        { ...base, sourceRevision: 'g'.repeat(64) },
        { ...base, sourceRevision: 42 },
        { ...base, sourceRevision: null }
      ]
      for (const bad of malformed) {
        await assert.rejects(harness.context.resolveAttachmentsForSend(harness.workspaceId, [bad], 2000), InvalidContextRequestError)
      }
      // Missing revision entirely is also invalid (old pre-15B shape).
      const withoutRevision = { ...base }
      delete withoutRevision['sourceRevision']
      await assert.rejects(
        harness.context.resolveAttachmentsForSend(harness.workspaceId, [withoutRevision], 2000),
        InvalidContextRequestError
      )
      // A well-formed but non-matching revision is stale, not silent success.
      const forged = { ...base, sourceRevision: '0'.repeat(64) }
      await assert.rejects(harness.context.resolveAttachmentsForSend(harness.workspaceId, [forged], 2000), StaleContextError)
      // Manual notes must not carry a file revision.
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'hi' })
      const noteWithRevision = { ...(note as unknown as Record<string, unknown>), sourceRevision: '0'.repeat(64) }
      await assert.rejects(
        harness.context.resolveAttachmentsForSend(harness.workspaceId, [noteWithRevision], 2000),
        InvalidContextRequestError
      )
    } finally {
      closeHarness(harness)
    }
  })

  it('16. renderer preview content cannot override disk/revision authority', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const forged = {
        ...(draft as unknown as Record<string, unknown>),
        content: 'EVIL INJECTED BY RENDERER',
        contentBytes: 25
      }
      const result = await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Go.',
        context: [forged]
      })
      // Disk wins: the forged preview string never reaches storage.
      assert.equal(result.context?.[0]?.content, 'const alpha = 1')
      assert.ok(!(result.context?.[0]?.content ?? '').includes('EVIL'))
    } finally {
      closeHarness(harness)
    }
  })

  it('critical: A reviewed, B on disk, send with revisionA sends neither', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      // PREPARE: content = A, revision = revisionA.
      const draft = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const contentA = (draft as FileSessionContextDraft).content
      const revisionA = sourceRevisionOf(draft)
      assert.ok(contentA.includes('const alpha = 1'))
      // CHANGE DISK: content = B, revision = revisionB.
      writeFileSync(join(harness.root, 'app.ts'), 'const B = 2\n')
      const revisionB = sha256Hex(readFileSync(join(harness.root, 'app.ts')))
      assert.notEqual(revisionB, revisionA)
      // SEND attachment carrying revisionA.
      await assert.rejects(
        harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: session.id,
          content: 'Use reviewed context.',
          context: [draft]
        }),
        (error: unknown) => {
          assert.ok(error instanceof StaleContextError)
          assert.equal((error as Error).message, STALE_CONTEXT_MESSAGE)
          return true
        }
      )
      // Assert: send rejected, B not sent, A not sent, no provider call, nothing persisted.
      assert.equal(messageCount(harness, session.id), 0)
      assert.equal(contextRowCount(harness.db), 0)
      assert.equal(harness.adapter.seen.length, 0)
      const page = await harness.sessions.listMessages({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.deepEqual(page.messages, [])
    } finally {
      closeHarness(harness)
    }
  })

  it('search-match send reconstructs the reviewed window when revision matches', async () => {
    const harness = openHarness()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const draft = await harness.context.prepareSearchMatch({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        line: 2
      })
      const preview = (draft as FileSessionContextDraft).content
      const result = await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Explain.',
        context: [draft]
      })
      // Revision matches, so reconstructed content must equal the preview.
      assert.equal(result.context?.[0]?.content, preview)
      assert.ok(preview.includes('const beta = 2'))
    } finally {
      closeHarness(harness)
    }
  })
})
