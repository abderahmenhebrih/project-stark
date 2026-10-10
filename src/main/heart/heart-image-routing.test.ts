import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { HeartRepository } from './heart-repository'
import { HeartImageUnsupportedError } from './heart-errors'
import { HeartService } from './heart-service'

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  async listModels(): Promise<readonly ProviderModel[]> {
    return []
  }
  async generateText(): Promise<{ text: string }> {
    return { text: 'x' }
  }
}

function openHeart(): { db: DatabaseSync; dir: string; heart: HeartService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const dir = mkdtempSync(join(tmpdir(), 'stark-heart-img-'))
  const heart = new HeartService(new HeartRepository(db), new AiProviderRepository(db), registry)
  return { db, dir, heart }
}

function closeHeart(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

describe('heart image-generation routing', () => {
  it('passes capable fixed routes through unchanged', () => {
    const h = openHeart()
    try {
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-image-1' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const route = h.heart.resolveWorkerForImageGeneration(h.heart.snapshot(), 'general')
      assert.equal(route.routeKey, 'fixed')
      assert.equal(route.assignment.model, 'gpt-image-1')
    } finally {
      closeHeart(h)
    }
  })

  it('fixed incapable routes fail explicitly with no rerouting', () => {
    const h = openHeart()
    try {
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-4o' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      assert.throws(() => h.heart.resolveWorkerForImageGeneration(h.heart.snapshot(), 'general'), HeartImageUnsupportedError)
    } finally {
      closeHeart(h)
    }
  })

  it('auto-swap selects a capable route and fails explicitly when none is capable', () => {
    const h = openHeart()
    try {
      h.heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'gpt-image-1' },
        workerRoutes: { general: { providerId: 'openai', model: 'gpt-4o' }, coding: null, reasoning: null, fast: null }
      })
      // Explicit general route is text-only; the capable default wins
      // under the existing explicit-first/default-second rules.
      const fallback = h.heart.resolveWorkerForImageGeneration(h.heart.snapshot(), 'general')
      assert.equal(fallback.assignment.model, 'gpt-image-1')
      const explicit = h.heart.resolveWorkerForImageGeneration(
        {
          ...h.heart.snapshot(),
          workerRoutes: { general: { providerId: 'openai', model: 'dall-e-3' }, coding: null, reasoning: null, fast: null }
        },
        'general'
      )
      assert.equal(explicit.routeKey, 'general')
      h.heart.updateConfig({
        workerMode: 'auto_swap',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: null,
        workerDefault: { providerId: 'openai', model: 'gpt-4o' },
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      assert.throws(() => h.heart.resolveWorkerForImageGeneration(h.heart.snapshot(), 'general'), HeartImageUnsupportedError)
    } finally {
      closeHeart(h)
    }
  })
})
