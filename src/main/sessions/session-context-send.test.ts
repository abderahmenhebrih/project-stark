import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { CodingSessionService } from './coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
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

function openHarness(): {
  db: DatabaseSync
  dir: string
  service: CodingSessionService
  context: SessionContextService
  completion: AiCompletionService
  adapter: FakeAdapter
  providerService: AiProviderService
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-ctx-send-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const service = new CodingSessionService(workspaces, sessions, { contextService: context })
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const completion = new AiCompletionService(workspaces, sessions, providerRows, providerService, registry)
  return { db, dir, service, context, completion, adapter, providerService, workspaceId }
}

describe('context send/list/generate integration', () => {
  it('send persists the message with its resolved context', async () => {
    const harness = openHarness()
    try {
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 2
      })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'Check the constants.' })
      const result = await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Review this code.',
        context: [excerpt, note]
      })
      assert.equal(result.message.content, 'Review this code.')
      assert.equal(result.context?.length, 2)
      assert.equal(result.context?.[0]?.kind, 'file-excerpt')
      assert.equal(result.context?.[0]?.content, 'const alpha = 1\nconst beta = 2')
      assert.equal(result.context?.[1]?.kind, 'manual-note')
      assert.equal(result.message.context?.length, 2)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('send without context stores an empty attachment list', async () => {
    const harness = openHarness()
    try {
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      const result = await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Plain question.'
      })
      assert.deepEqual(result.context ?? [], [])
      assert.deepEqual(result.message.context ?? [], [])
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('listMessages attaches sent context to history', async () => {
    const harness = openHarness()
    try {
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 3,
        lineEnd: 3
      })
      await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'What is gamma?',
        context: [excerpt]
      })
      await harness.service.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Follow-up.' })
      const page = await harness.service.listMessages({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(page.messages.length, 2)
      assert.equal(page.messages[0]?.context?.length, 1)
      assert.equal(page.messages[0]?.context?.[0]?.content, 'const gamma = 3')
      assert.equal(page.messages[0]?.context?.[0]?.lineStart, 3)
      assert.deepEqual(page.messages[1]?.context ?? [], [])
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('removed drafts never reach storage', async () => {
    const harness = openHarness()
    try {
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      // Renderer drops the draft before send: only the kept note goes out.
      await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Only the note.',
        context: [
          {
            draftId: 'ctx-9',
            kind: 'manual-note',
            label: 'Manual note',
            relativePath: null,
            lineStart: null,
            lineEnd: null,
            content: 'kept note',
            contentBytes: 9
          }
        ]
      })
      const page = await harness.service.listMessages({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(page.messages[0]?.context?.length, 1)
      assert.equal(page.messages[0]?.context?.[0]?.content, 'kept note')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('generation includes only the trailing message context block', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 1,
        lineEnd: 1
      })
      await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'First question.',
        context: [excerpt]
      })
      await harness.service.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Second, no context.' })
      const result = await harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(result.message.role, 'assistant')
      // No context block when the trailing message carries none.
      assert.deepEqual(harness.adapter.seen[0]?.messages.map((entry) => entry.content), [
        'First question.',
        'Second, no context.'
      ])
      assert.deepEqual(result.message.context ?? [], [])
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('generation prepends the deterministic context block for attached context', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.service.createSession({ workspaceId: harness.workspaceId })
      const excerpt = await harness.context.prepareExcerpt({
        workspaceId: harness.workspaceId,
        relativePath: 'app.ts',
        lineStart: 2,
        lineEnd: 2
      })
      await harness.service.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Explain this line.',
        context: [excerpt]
      })
      await harness.completion.generateResponse({ workspaceId: harness.workspaceId, sessionId: session.id })
      const sent = harness.adapter.seen[0]?.messages.map((entry) => entry.content) ?? []
      assert.equal(sent.length, 2)
      assert.ok(sent[0]?.startsWith('[CONTEXT 1]\nType: file-excerpt\nPath: app.ts\nLines: 2-2\nContent:\nconst beta = 2'))
      assert.equal(sent[1], 'Explain this line.')
      // Nothing beyond the explicit attachment travels.
      assert.ok(!sent.join('\n').includes('gamma'))
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
