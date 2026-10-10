import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ChatAttachmentService } from '../chat-attachments/service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiCompletionService } from './ai-completion-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
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

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  seen: (ProviderGenerateRequest & { apiKey: string })[] = []
  nextText = 'done'

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
  completion: AiCompletionService
  adapter: FakeAdapter
  workspaces: WorkspaceRepository
  sessions: CodingSessionService
  store: CodingSessionRepository
  attachments: ChatAttachmentService
  providerService: AiProviderService
  dir: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const store = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const dir = mkdtempSync(join(tmpdir(), 'stark-ai-understand-'))
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, store)
  const completion = new AiCompletionService(workspaces, store, providerRows, providerService, registry, {
    attachments
  })
  const sessions = new CodingSessionService(workspaces, store, { attachmentService: attachments })
  const workspaceId = workspaces.create({ rootPath: join(dir, 'project'), displayName: 'project', now: 1000 }).id
  return { db, completion, adapter, workspaces, sessions, store, attachments, providerService, dir, workspaceId }
}

function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepngdata')])
}

async function configure(h: ReturnType<typeof openHarness>, model: string): Promise<void> {
  await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await h.providerService.setModel({ providerId: 'openai', model })
}

async function sendWith(h: ReturnType<typeof openHarness>, filename: string, bytes: Buffer, content: string): Promise<number> {
  const source = join(h.dir, filename)
  writeFileSync(source, bytes)
  const [stored] = await h.attachments.chooseAttachments(h.workspaceId, [source])
  if (stored === undefined) {
    throw new Error('unreachable')
  }
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  const sent = await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content, attachments: [stored.id] })
  return sent.session.id
}

describe('AI attachment understanding (Ask)', () => {
  it('sends image bytes plus the review block to a vision model', async () => {
    const h = openHarness()
    try {
      await configure(h, 'gpt-4o')
      const sessionId = await sendWith(h, 'hero.png', pngBytes(), 'Use this as the hero image.')
      const result = await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId })
      assert.equal(result.message.role, 'assistant')
      assert.equal(h.adapter.seen.length, 1)
      const request = h.adapter.seen[0]
      if (request === undefined) {
        throw new Error('unreachable')
      }
      // Review block travels as a separate user-role message (Stage 15 invariant).
      const review = request.messages.find((entry) => entry.content.startsWith('[ATTACHMENTS 1]'))
      assert.ok(review !== undefined, 'review block must be part of the provider input')
      assert.ok(review.content.includes('hero.png'))
      assert.ok(review.content.includes('image included in model request'))
      // Native multimodal payload, main-encoded — never a filesystem path.
      assert.equal(request.attachments?.length, 1)
      const image = request.attachments?.[0]
      assert.ok(image?.kind === 'image')
      assert.equal(image.mimeType, 'image/png')
      assert.ok(image.base64.length > 0)
      assert.equal(Buffer.from(image.base64, 'base64').subarray(0, 4).toString('hex'), '89504e47')
      const serialized = JSON.stringify({ messages: request.messages, attachments: request.attachments })
      assert.ok(!serialized.includes(h.dir), 'no filesystem path may reach the provider')
      assert.ok(!serialized.includes('.bin'), 'no store path may reach the provider')
      assert.ok(!serialized.includes('stark-attachment://'), 'no protocol URL may reach the provider')
      // Attachment content never enters developer instructions.
      assert.ok(!request.instructions.includes('fakepngdata'))
      assert.ok(!request.instructions.includes('hero.png'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('returns an explicit capability error for non-vision models', async () => {
    const h = openHarness()
    try {
      await configure(h, 'gpt-3.5-turbo')
      const sessionId = await sendWith(h, 'hero.png', pngBytes(), 'Describe this image')
      await assert.rejects(
        h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId }),
        /The selected model cannot view image attachments\./
      )
      assert.equal(h.adapter.seen.length, 0)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('sends bounded text attachments structurally apart from instructions', async () => {
    const h = openHarness()
    try {
      await configure(h, 'gpt-3.5-turbo')
      const sessionId = await sendWith(h, 'notes.md', Buffer.from('# Plan\nship it\n', 'utf8'), 'Read this')
      await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId })
      const request = h.adapter.seen[0]
      if (request === undefined) {
        throw new Error('unreachable')
      }
      assert.equal(request.attachments?.length, 1)
      assert.ok(request.attachments?.[0]?.kind === 'text')
      assert.ok(!request.instructions.includes('# Plan'))
      const review = request.messages.find((entry) => entry.content.startsWith('[ATTACHMENTS 1]'))
      assert.ok(review?.content.includes('text included'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('presents binary documents as explicitly-labeled metadata only', async () => {
    const h = openHarness()
    try {
      await configure(h, 'gpt-4o')
      const sessionId = await sendWith(h, 'doc.pdf', Buffer.from('%PDF-1.4 fake', 'utf8'), 'Read this')
      await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId })
      const request = h.adapter.seen[0]
      if (request === undefined) {
        throw new Error('unreachable')
      }
      assert.equal(request.attachments?.length ?? 0, 0)
      const review = request.messages.find((entry) => entry.content.startsWith('[ATTACHMENTS 1]'))
      assert.ok(review?.content.includes('content not included'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('sends no attachment section for text-only messages', async () => {
    const h = openHarness()
    try {
      await configure(h, 'gpt-4o')
      const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Hello' })
      await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId: session.id })
      const request = h.adapter.seen[0]
      if (request === undefined) {
        throw new Error('unreachable')
      }
      assert.ok(!request.messages.some((entry) => entry.content.startsWith('[ATTACHMENTS ')))
      assert.equal(request.attachments?.length ?? 0, 0)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
