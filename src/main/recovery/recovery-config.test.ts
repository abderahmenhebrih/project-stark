import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { RecoveryRepository } from './recovery-repository'
import { RecoveryService } from './recovery-service'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import type { AiProviderAdapter } from '../ai/provider-adapter'

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }
  async generateText(): Promise<{ text: string }> {
    return { text: 'x' }
  }
}

function openHarness(): { db: DatabaseSync; service: RecoveryService; store: RecoveryRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const providerRows = new AiProviderRepository(db)
  const store = new RecoveryRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const service = new RecoveryService(store, providerRows, registry)
  return { db, service, store }
}

describe('recovery config', () => {
  it('defaults to null before configuration and off via ensure', () => {
    const { db, service } = openHarness()
    try {
      assert.equal(service.getConfig(), null)
      assert.deepEqual(service.ensureConfig(), { mode: 'off', ask: null, brain: null, worker: null })
    } finally {
      db.close()
    }
  })

  it('saves off with optional assignments', () => {
    const { db, service } = openHarness()
    try {
      const saved = service.updateConfig({ mode: 'off', ask: null, brain: null, worker: null })
      assert.deepEqual(saved, { mode: 'off', ask: null, brain: null, worker: null })
    } finally {
      db.close()
    }
  })

  it('saves handoff with optional assignments', () => {
    const { db, service } = openHarness()
    try {
      const saved = service.updateConfig({ mode: 'handoff', ask: null, brain: null, worker: null })
      assert.equal(saved.mode, 'handoff')
    } finally {
      db.close()
    }
  })

  it('saves complete auto_once config', () => {
    const { db, service } = openHarness()
    try {
      const saved = service.updateConfig({
        mode: 'auto_once',
        ask: { providerId: 'openai', model: 'r-ask' },
        brain: { providerId: 'openai', model: 'r-brain' },
        worker: { providerId: 'openai', model: 'r-worker' }
      })
      assert.equal(saved.mode, 'auto_once')
      assert.deepEqual(saved.ask, { providerId: 'openai', model: 'r-ask' })
      assert.deepEqual(saved.brain, { providerId: 'openai', model: 'r-brain' })
      assert.deepEqual(saved.worker, { providerId: 'openai', model: 'r-worker' })
    } finally {
      db.close()
    }
  })

  it('rejects auto_once missing ask/brain/worker', () => {
    const { db, service } = openHarness()
    try {
      assert.throws(() =>
        service.updateConfig({ mode: 'auto_once', ask: null, brain: { providerId: 'openai', model: 'b' }, worker: { providerId: 'openai', model: 'w' } })
      )
      assert.throws(() =>
        service.updateConfig({ mode: 'auto_once', ask: { providerId: 'openai', model: 'a' }, brain: null, worker: { providerId: 'openai', model: 'w' } })
      )
      assert.throws(() =>
        service.updateConfig({ mode: 'auto_once', ask: { providerId: 'openai', model: 'a' }, brain: { providerId: 'openai', model: 'b' }, worker: null })
      )
    } finally {
      db.close()
    }
  })

  it('rejects unknown provider and bad shapes', () => {
    const { db, service } = openHarness()
    try {
      assert.throws(() =>
        service.updateConfig({ mode: 'handoff', ask: { providerId: 'nope', model: 'm' }, brain: null, worker: null })
      )
      assert.throws(() => service.updateConfig({ mode: 'sometimes', ask: null, brain: null, worker: null }))
      assert.throws(() => service.updateConfig({ mode: 'off', ask: { providerId: '', model: 'm' }, brain: null, worker: null }))
    } finally {
      db.close()
    }
  })

  it('enforces provider/model bounds, NUL, and Unicode', () => {
    const { db, service } = openHarness()
    try {
      assert.throws(() =>
        service.updateConfig({ mode: 'handoff', ask: { providerId: 'a'.repeat(101), model: 'm' }, brain: null, worker: null })
      )
      assert.throws(() =>
        service.updateConfig({ mode: 'handoff', ask: { providerId: 'openai', model: 'm'.repeat(201) }, brain: null, worker: null })
      )
      assert.throws(() =>
        service.updateConfig({ mode: 'handoff', ask: { providerId: 'openai', model: String.fromCharCode(0) }, brain: null, worker: null })
      )
      assert.throws(() =>
        service.updateConfig({ mode: 'handoff', ask: { providerId: 'openai', model: String.fromCharCode(0xd800) }, brain: null, worker: null })
      )
      const saved = service.updateConfig({ mode: 'handoff', ask: { providerId: 'openai', model: 'modele-ok' }, brain: null, worker: null })
      assert.equal(saved.ask?.model, 'modele-ok')
    } finally {
      db.close()
    }
  })

  it('atomic save fault leaves previous config intact', () => {
    const { db, service, store } = openHarness()
    try {
      const first = service.updateConfig({
        mode: 'auto_once',
        ask: { providerId: 'openai', model: 'a1' },
        brain: { providerId: 'openai', model: 'b1' },
        worker: { providerId: 'openai', model: 'w1' }
      })
      assert.equal(first.ask?.model, 'a1')
      assert.throws(() =>
        store.saveConfig(
          { mode: 'handoff', assignments: [{ role: 'ask', providerId: 'openai', model: 'a2' }], now: 9999 },
          { failAfterAssignments: 0 }
        )
      )
      const after = service.getConfig()
      assert.deepEqual(after, first)
    } finally {
      db.close()
    }
  })

  it('removed assignments are cleaned (complete replacement)', () => {
    const { db, service, store } = openHarness()
    try {
      service.updateConfig({
        mode: 'auto_once',
        ask: { providerId: 'openai', model: 'a' },
        brain: { providerId: 'openai', model: 'b' },
        worker: { providerId: 'openai', model: 'w' }
      })
      assert.equal(store.listAssignments().length, 3)
      service.updateConfig({ mode: 'handoff', ask: null, brain: null, worker: null })
      assert.equal(store.listAssignments().length, 0)
    } finally {
      db.close()
    }
  })

  it('saving performs zero network calls and stores no credentials', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'recovery', 'recovery-service.ts'), 'utf8')
    assert.ok(!source.includes('fetch('), 'recovery config must not fetch')
    assert.ok(!source.includes('billing'), 'no billing')
    const { db, service } = openHarness()
    try {
      service.updateConfig({ mode: 'handoff', ask: { providerId: 'openai', model: 'm' }, brain: null, worker: null })
      const rows = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('ai_recovery_assignments') as unknown
      assert.ok(rows !== undefined)
      const cols: unknown = db.prepare("SELECT name FROM pragma_table_info('ai_recovery_assignments')").all()
      const names = JSON.stringify(cols)
      assert.ok(!names.includes('credential'))
      assert.ok(!names.includes('api_key'))
      assert.ok(!names.includes('endpoint'))
    } finally {
      db.close()
    }
  })
})
