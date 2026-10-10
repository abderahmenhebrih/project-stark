import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { HeartRepository } from './heart-repository'
import { HeartService } from './heart-service'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { VisionUnsupportedForModelError } from '../ai/ai-attachment-context'

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

function openService(): { db: DatabaseSync; heart: HeartService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const providerRows = new AiProviderRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const heart = new HeartService(new HeartRepository(db), providerRows, registry)
  return { db, heart }
}

describe('heart attachment capability routing', () => {
  it('routes non-vision sets unchanged when no vision is needed', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-3.5-turbo' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const snapshot = heart.snapshot()
      const resolved = heart.resolveWorkerForAttachments(snapshot, 'general', false)
      assert.deepEqual(resolved.assignment, { providerId: 'openai', model: 'gpt-3.5-turbo' })
      assert.equal(resolved.routeKey, 'fixed')
    } finally {
      db.close()
    }
  })

  it('fixed mode fails explicitly when the fixed model cannot view images', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-3.5-turbo' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const snapshot = heart.snapshot()
      // No secret rerouting in fixed mode — an explicit capability error.
      assert.throws(() => heart.resolveWorkerForAttachments(snapshot, 'general', true), VisionUnsupportedForModelError)
    } finally {
      db.close()
    }
  })

  it('auto-swap prefers the explicit capable route, then the capable default', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'gpt-4o-mini' },
        workerRoutes: { general: { providerId: 'openai', model: 'gpt-3.5-turbo' }, coding: null, reasoning: null, fast: null }
      })
      const snapshot = heart.snapshot()
      // Explicit general route is incapable; configured default is capable.
      const resolved = heart.resolveWorkerForAttachments(snapshot, 'general', true)
      assert.deepEqual(resolved.assignment, { providerId: 'openai', model: 'gpt-4o-mini' })
      assert.equal(resolved.routeKey, 'default')
    } finally {
      db.close()
    }
  })

  it('auto-swap keeps a capable explicit route and fails explicitly when none is capable', () => {
    const { db, heart } = openService()
    try {
      heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'gpt-3.5-turbo' },
        workerRoutes: { general: null, coding: { providerId: 'openai', model: 'gpt-4o' }, reasoning: null, fast: null }
      })
      const snapshot = heart.snapshot()
      const coding = heart.resolveWorkerForAttachments(snapshot, 'coding', true)
      assert.equal(coding.routeKey, 'coding')
      assert.throws(() => heart.resolveWorkerForAttachments(snapshot, 'general', true), VisionUnsupportedForModelError)
    } finally {
      db.close()
    }
  })
})
