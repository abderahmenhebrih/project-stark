import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { MAX_GENERATED_IMAGES } from '../../shared/ai/image-capabilities'
import { getUserVersion } from '../database/migrations/index'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderImageGenerationRequest,
  ProviderGeneratedImage
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import { ChatAttachmentService } from '../chat-attachments/service'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import {
  ImageCapabilityUnsupportedError,
  ImageGenerationFailedError,
  ImageGenerationTimeoutError,
  ImageProviderUnavailableError,
  InvalidImageGenerationRequestError,
  toPublicImageGenerationError
} from './errors'
import { ImageGenerationService } from './image-generation-service'

function pngBytes(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)])
}

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

class FakeImageAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  script: ((count: number) => ProviderGeneratedImage[])[] = []
  calls: (ProviderImageGenerationRequest & { readonly apiKey: string })[] = []
  inFlight = 0
  maxInFlight = 0

  async listModels(): Promise<readonly []> {
    return []
  }

  async generateText(): Promise<{ text: string }> {
    throw new Error('image tests never use text chat')
  }

  async generateImages(
    request: ProviderImageGenerationRequest & { readonly apiKey: string }
  ): Promise<readonly ProviderGeneratedImage[]> {
    this.calls.push(request)
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      const next = this.script.shift()
      if (next === undefined) {
        throw new Error('image script exhausted (no retry expected)')
      }
      return next(request.count)
    } finally {
      this.inFlight -= 1
    }
  }
}

function openHarness(options?: { heart?: boolean; credential?: boolean; imageModel?: boolean }): {
  db: DatabaseSync
  dir: string
  service: ImageGenerationService
  adapter: FakeImageAdapter
  attachments: ChatAttachmentService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-image-gen-'))
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, codingRows)
  const registry = new ProviderRegistry()
  const adapter = new FakeImageAdapter()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  if (options?.credential !== false) {
    providerRows.setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
  }
  let heart: HeartService | undefined
  if (options?.heart === true) {
    heart = new HeartService(new HeartRepository(db), providerRows, registry)
    heart.updateConfig({
      workerMode: 'fixed',
      brain: { providerId: 'openai', model: 'gpt-4o' },
      workerFixed: { providerId: 'openai', model: options?.imageModel === false ? 'gpt-4o' : 'gpt-image-1' },
      workerDefault: null,
      workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
    })
  }
  const service = new ImageGenerationService({
    providerService,
    registry,
    attachments,
    ...(heart === undefined ? {} : { heart })
  })
  return { db, dir, service, adapter, attachments }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

describe('image generation service', () => {
  it('validates prompt/count/size before any provider call', async () => {
    const h = openHarness()
    try {
      await assert.rejects(h.service.generateImages({ prompt: '', count: 1 }), InvalidImageGenerationRequestError)
      await assert.rejects(h.service.generateImages({ prompt: 'x', count: 0 }), InvalidImageGenerationRequestError)
      await assert.rejects(h.service.generateImages({ prompt: 'x', count: 5 }), InvalidImageGenerationRequestError)
      await assert.rejects(h.service.generateImages({ prompt: 'x', count: 1, size: 'nope' }), InvalidImageGenerationRequestError)
      assert.equal(h.adapter.calls.length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('fails closed without credential or image-capable adapter', async () => {
    const noCredential = openHarness({ credential: false })
    try {
      await assert.rejects(noCredential.service.generateImages({ prompt: 'x', count: 1 }), ImageProviderUnavailableError)
    } finally {
      closeHarness(noCredential)
    }
    const db = new DatabaseSync(':memory:')
    runMigrations(db, migrations)
    const dir = mkdtempSync(join(tmpdir(), 'stark-image-gen-'))
    try {
      const workspaces = new WorkspaceRepository(db)
      const codingRows = new CodingSessionRepository(db)
      const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, codingRows)
      const registry = new ProviderRegistry()
      registry.register({
        id: 'openai',
        displayName: 'OpenAI',
        listModels: async () => [],
        generateText: async () => ({ text: 'x' })
      } satisfies AiProviderAdapter)
      const providerRows = new AiProviderRepository(db)
      providerRows.setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
      const service = new ImageGenerationService({ providerService: new AiProviderService(providerRows, new FakeProtector(), registry), registry, attachments })
      await assert.rejects(service.generateImages({ prompt: 'x', count: 1 }), ImageCapabilityUnsupportedError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('single generation stores a normal attachment with exact SHA-256', async () => {
    const h = openHarness()
    try {
      const bytes = pngBytes('one')
      h.adapter.script = [(count) => [{ bytes: new Uint8Array(bytes), mimeType: 'image/png' }].slice(0, count)]
      const outcome = await h.service.generateImages({ prompt: 'a hero', count: 1 })
      assert.equal(outcome.images.length, 1)
      assert.equal(outcome.failedCount, 0)
      const stored = outcome.images[0]
      assert.equal(stored?.attachment.kind, 'image')
      assert.equal(stored?.attachment.mimeType, 'image/png')
      assert.equal(stored?.sha256, createHash('sha256').update(bytes).digest('hex'))
      const content = h.attachments.readAttachmentContent(stored?.attachment.id ?? '')
      assert.ok(Buffer.from(content.bytes).equals(bytes))
      // The model never supplies provider URLs, credentials, or paths.
      assert.deepEqual(Object.keys(h.adapter.calls[0] ?? {}).sort(), ['apiKey', 'count', 'model', 'prompt'])
    } finally {
      closeHarness(h)
    }
  })

  it('multi-generation preserves count and order in one bounded request', async () => {
    const h = openHarness()
    try {
      h.adapter.script = [
        (count) => ['a', 'b', 'c', 'd'].slice(0, count).map((seed) => ({ bytes: new Uint8Array(pngBytes(seed)), mimeType: 'image/png' }))
      ]
      const outcome = await h.service.generateImages({ prompt: '4 variations', count: 4 })
      assert.equal(outcome.images.length, 4)
      assert.equal(outcome.failedCount, 0)
      // One bounded request (native multi-output) — trivially within
      // the ≤2 concurrent fan-out bound, never more.
      assert.equal(h.adapter.calls.length, 1)
      assert.ok(h.adapter.maxInFlight <= 2)
      assert.equal(h.adapter.calls[0]?.count, 4)
      const names = outcome.images.map((entry) => entry.attachment.name)
      assert.deepEqual(names, ['generated-image-1.png', 'generated-image-2.png', 'generated-image-3.png', 'generated-image-4.png'])
    } finally {
      closeHarness(h)
    }
  })

  it('partial success persists valid images with no automatic retry', async () => {
    const h = openHarness()
    try {
      // Short provider response: one valid image of three requested.
      // Successes persist with a safe failed count; nothing retries.
      h.adapter.script = [
        () => [{ bytes: new Uint8Array(pngBytes('good')), mimeType: 'image/png' }]
      ]
      const outcome = await h.service.generateImages({ prompt: '3 ideas', count: 3 })
      assert.equal(outcome.images.length, 1)
      assert.equal(outcome.failedCount, 2)
      assert.equal(h.adapter.calls.length, 1)
      // Total provider failure is bounded with a single attempt.
      h.adapter.script = [
        () => {
          throw new Error('provider exploded')
        }
      ]
      await assert.rejects(h.service.generateImages({ prompt: 'x', count: 1 }), ImageGenerationFailedError)
      assert.equal(h.adapter.calls.length, 2)
    } finally {
      closeHarness(h)
    }
  })

  it('drops invalid and oversize provider output bounded', async () => {
    const h = openHarness()
    try {
      h.adapter.script = [() => [{ bytes: new Uint8Array(Buffer.from('not-an-image')), mimeType: 'image/png' }]]
      await assert.rejects(h.service.generateImages({ prompt: 'x', count: 1 }), ImageGenerationFailedError)
    } finally {
      closeHarness(h)
    }
  })

  it('fixed incapable Heart routes fail explicitly; auto-swap obeys policy', async () => {
    const fixed = openHarness({ heart: true, imageModel: false })
    try {
      await assert.rejects(fixed.service.generateImages({ prompt: 'x', count: 1 }), ImageCapabilityUnsupportedError)
      assert.equal(fixed.adapter.calls.length, 0)
    } finally {
      closeHarness(fixed)
    }
    const capable = openHarness({ heart: true, imageModel: true })
    try {
      capable.adapter.script = [(count) => [{ bytes: new Uint8Array(pngBytes('ok')), mimeType: 'image/png' }].slice(0, count)]
      const outcome = await capable.service.generateImages({ prompt: 'x', count: 1 })
      assert.equal(outcome.images.length, 1)
      assert.equal(capable.adapter.calls[0]?.model, 'gpt-image-1')
    } finally {
      closeHarness(capable)
    }
  })

  it('issues at most one provider call per approved invocation', () => {
    assert.equal(MAX_GENERATED_IMAGES, 4)
  })

  it('enforces the outer tool bound with no retry', async () => {
    const h = openHarness()
    try {
      h.adapter.script = [() => new Promise<never>(() => {}) as never]
      await assert.rejects(
        h.service.generateImages({ prompt: 'x', count: 1, outerTimeoutMs: 50 }),
        ImageGenerationTimeoutError
      )
      assert.equal(h.adapter.calls.length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('stays on schema v19 with no new migration', async () => {
    const h = openHarness()
    try {
      const { readFileSync, readdirSync } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      assert.equal(getUserVersion(h.db), 19)
      const files = readdirSync(joinPath(process.cwd(), 'src', 'main', 'database', 'migrations'))
      assert.ok(!files.some((file) => file.startsWith('020-')), 'no migration 020')
      void readFileSync
    } finally {
      closeHarness(h)
    }
  })

  it('normalizes failures with no raw provider detail', () => {
    assert.equal(toPublicImageGenerationError(new ImageProviderUnavailableError()).message, 'No image-generation provider is configured.')
    assert.equal(toPublicImageGenerationError(new ImageCapabilityUnsupportedError()).message, 'The selected provider cannot generate images.')
    assert.equal(toPublicImageGenerationError(new Error('sk-secret https://x')).message, 'Image generation failed.')
    assert.ok(!toPublicImageGenerationError(new Error('sk-secret')).message.includes('sk-secret'))
  })
})
