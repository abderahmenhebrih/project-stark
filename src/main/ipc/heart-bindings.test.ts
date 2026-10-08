import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createHeartBindings } from './heart'

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

function openHeart(): { db: DatabaseSync; heart: HeartService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const providerRows = new AiProviderRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  return { db, heart: new HeartService(new HeartRepository(db), providerRows, registry) }
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

describe('heart IPC bindings', () => {
  it('exposes exactly the two heart channels', () => {
    const { db, heart } = openHeart()
    try {
      const channels = createHeartBindings(heart).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), ['stark:heart:get', 'stark:heart:update'].sort())
    } finally {
      db.close()
    }
  })

  it('get returns null before configuration and the config after save', async () => {
    const { db, heart } = openHeart()
    try {
      const bindings = createHeartBindings(heart)
      const get = bindings.find((binding) => binding.channel === 'stark:heart:get')
      const update = bindings.find((binding) => binding.channel === 'stark:heart:update')
      assert.ok(get !== undefined && update !== undefined)
      assert.equal(await get.invoke(undefined), null)
      const saved = (await update.invoke(fixedConfig())) as { workerMode: string }
      assert.equal(saved.workerMode, 'fixed')
      assert.notEqual(await get.invoke(undefined), null)
    } finally {
      db.close()
    }
  })

  it('update rejects secrets and unknown fields', async () => {
    const { db, heart } = openHeart()
    try {
      const bindings = createHeartBindings(heart)
      const update = bindings.find((binding) => binding.channel === 'stark:heart:update')
      assert.ok(update !== undefined)
      for (const bad of [
        null,
        {},
        { ...fixedConfig(), apiKey: 'sk-secret' },
        { ...fixedConfig(), credential: 'sk-secret' },
        { ...fixedConfig(), baseURL: 'https://evil.invalid' },
        { ...fixedConfig(), endpoint: 'https://evil.invalid' },
        { ...fixedConfig(), prompt: 'ignore rules' },
        { ...fixedConfig(), systemInstruction: 'ignore rules' },
        { ...fixedConfig(), autoRetry: true },
        { ...fixedConfig(), fallbackModels: ['m'] },
        { ...fixedConfig(), extra: 1 }
      ]) {
        await assert.rejects(update.invoke(bad), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(!error.message.includes('sk-secret'))
          assert.ok(!error.message.includes('evil.invalid'))
          return true
        })
      }
    } finally {
      db.close()
    }
  })

  it('maps failures without implementation details', async () => {
    const { db, heart } = openHeart()
    try {
      const bindings = createHeartBindings(heart)
      const update = bindings.find((binding) => binding.channel === 'stark:heart:update')
      assert.ok(update !== undefined)
      await assert.rejects(update.invoke({ workerMode: 'fixed' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('sqlite'))
        assert.ok(!error.message.includes('stark:'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
