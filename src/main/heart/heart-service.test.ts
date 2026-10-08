import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { HeartRepository } from './heart-repository'
import { HeartService } from './heart-service'
import type { CredentialProtector } from '../ai/credential-protector'
import { AiProviderService } from '../ai/ai-provider-service'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { HeartUnconfiguredError, InvalidHeartRequestError } from './heart-errors'

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

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' }
  }
}

function openService(): {
  db: DatabaseSync
  heart: HeartService
  providers: AiProviderService
  providerRows: AiProviderRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const providerRows = new AiProviderRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const providers = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(new HeartRepository(db), providerRows, registry)
  return { db, heart, providers, providerRows }
}

function fixedConfig(): Record<string, unknown> {
  return {
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'model-B' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  }
}

describe('heart service', () => {
  it('loads null before configuration and round-trips a fixed config', async () => {
    const { db, heart } = openService()
    try {
      assert.equal(heart.getConfig(), null)
      const saved = heart.updateConfig(fixedConfig())
      assert.equal(saved.workerMode, 'fixed')
      assert.deepEqual(saved.brain, { providerId: 'openai', model: 'model-A' })
      assert.deepEqual(heart.getConfig(), saved)
    } finally {
      db.close()
    }
  })

  it('initializes once from legacy selection without mutating it', async () => {
    const { db, heart, providers } = openService()
    try {
      await providers.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await providers.setModel({ providerId: 'openai', model: 'model-LEGACY' })
      const first = heart.ensureReady()
      assert.equal(first.workerMode, 'fixed')
      assert.deepEqual(first.brain, { providerId: 'openai', model: 'model-LEGACY' })
      assert.deepEqual(first.workerFixed, { providerId: 'openai', model: 'model-LEGACY' })
      const second = heart.ensureReady()
      assert.deepEqual(second, first)
      // Legacy selection untouched.
      assert.equal((await providers.getState({ providerId: 'openai' })).selectedModel, 'model-LEGACY')
    } finally {
      db.close()
    }
  })

  it('returns safe unconfigured when no legacy model exists', () => {
    const { db, heart } = openService()
    try {
      assert.throws(() => heart.ensureReady(), HeartUnconfiguredError)
    } finally {
      db.close()
    }
  })

  it('validates config strictly, including unknown providers and bad values', () => {
    const { db, heart } = openService()
    try {
      assert.throws(() => heart.updateConfig({ workerMode: 'fixed' }), InvalidHeartRequestError)
      assert.throws(() => heart.updateConfig({ ...fixedConfig(), workerMode: 'turbo' }), InvalidHeartRequestError)
      assert.throws(() => heart.updateConfig({ ...fixedConfig(), brain: null }), InvalidHeartRequestError)
      assert.throws(
        () => heart.updateConfig({ ...fixedConfig(), brain: { providerId: 'unknown', model: 'm' } }),
        /not available|invalid/
      )
      assert.throws(
        () => heart.updateConfig({ ...fixedConfig(), brain: { providerId: 'openai', model: '' } }),
        InvalidHeartRequestError
      )
      assert.throws(
        () => heart.updateConfig({ ...fixedConfig(), brain: { providerId: 'openai', model: 'x'.repeat(201) } }),
        InvalidHeartRequestError
      )
      assert.throws(
        () => heart.updateConfig({ ...fixedConfig(), apiKey: 'sk-secret' }),
        InvalidHeartRequestError
      )
      assert.throws(
        () => heart.updateConfig({ ...fixedConfig(), brain: { providerId: 'openai', model: 'm', endpoint: 'https://x' } }),
        InvalidHeartRequestError
      )
    } finally {
      db.close()
    }
  })

  it('resolves fixed, exact, and default routes with no network', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'model-D' },
        workerRoutes: {
          general: null,
          coding: { providerId: 'openai', model: 'model-C' },
          reasoning: null,
          fast: null
        }
      })
      const snapshot = heart.snapshot()
      assert.deepEqual(heart.resolveWorker(snapshot, 'coding'), {
        assignment: { providerId: 'openai', model: 'model-C' },
        routeKey: 'coding'
      })
      assert.deepEqual(heart.resolveWorker(snapshot, 'reasoning'), {
        assignment: { providerId: 'openai', model: 'model-D' },
        routeKey: 'default'
      })
      assert.deepEqual(heart.resolveWorker(snapshot, 'general'), {
        assignment: { providerId: 'openai', model: 'model-D' },
        routeKey: 'default'
      })
      assert.deepEqual(heart.resolveWorker(snapshot, 'fast'), {
        assignment: { providerId: 'openai', model: 'model-D' },
        routeKey: 'default'
      })
      assert.throws(() => heart.resolveWorker(snapshot, 'turbo'), InvalidHeartRequestError)
    } finally {
      db.close()
    }
  })

  it('snapshot is immutable against later config changes', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig(fixedConfig())
      const snapshot = heart.snapshot()
      heart.updateConfig({
        ...fixedConfig(),
        brain: { providerId: 'openai', model: 'model-X' },
        workerFixed: { providerId: 'openai', model: 'model-Y' }
      })
      assert.deepEqual(snapshot.brain, { providerId: 'openai', model: 'model-A' })
      assert.deepEqual(snapshot.workerFixed, { providerId: 'openai', model: 'model-B' })
      assert.deepEqual(heart.getConfig()?.brain, { providerId: 'openai', model: 'model-X' })
    } finally {
      db.close()
    }
  })
})
