import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RecoveryService } from '../recovery/recovery-service'
import { createRecoveryBindings } from './recovery'

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

function openHarness(): { db: DatabaseSync; bindings: ReturnType<typeof createRecoveryBindings>; store: RecoveryRepository; service: RecoveryService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providers = new AiProviderRepository(db)
  const store = new RecoveryRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const service = new RecoveryService(store, providers, registry)
  const bindings = createRecoveryBindings(service, store, workspaces, sessions)
  return { db, bindings, store, service }
}

describe('recovery IPC bindings', () => {
  it('exposes exactly five recovery channels', () => {
    const { db, bindings } = openHarness()
    try {
      assert.deepEqual(
        [...bindings.map((b) => b.channel)].sort(),
        [
          IPC_CHANNELS.recoveryGetConfig,
          IPC_CHANNELS.recoveryUpdateConfig,
          IPC_CHANNELS.recoveryGetForSource,
          IPC_CHANNELS.recoveryGetForTarget,
          IPC_CHANNELS.recoveryDismiss
        ].sort()
      )
    } finally {
      db.close()
    }
  })

  it('get/update round-trips config with no secrets', async () => {
    const { db, bindings } = openHarness()
    try {
      const get = bindings.find((b) => b.channel === IPC_CHANNELS.recoveryGetConfig)
      const update = bindings.find((b) => b.channel === IPC_CHANNELS.recoveryUpdateConfig)
      assert.ok(get && update)
      assert.equal(await get.invoke(undefined, undefined as never), null)
      const saved = (await update.invoke(
        { mode: 'auto_once', ask: { providerId: 'openai', model: 'a' }, brain: { providerId: 'openai', model: 'b' }, worker: { providerId: 'openai', model: 'w' } },
        undefined as never
      )) as { mode: string }
      assert.equal(saved.mode, 'auto_once')
      assert.ok(JSON.stringify(saved).includes('openai'))
      assert.ok(!JSON.stringify(saved).toLowerCase().includes('key'))
    } finally {
      db.close()
    }
  })

  it('lookup and dismiss validate strictly with no retry-now surface', async () => {
    const { db, bindings } = openHarness()
    try {
      const channels = bindings.map((b) => b.channel)
      assert.ok(!channels.some((c) => c.includes('retry')))
      assert.ok(!channels.some((c) => c.includes('route-now')))
      const forSource = bindings.find((b) => b.channel === IPC_CHANNELS.recoveryGetForSource)
      assert.ok(forSource)
      await assert.rejects(forSource.invoke({ workspaceId: 1 }, undefined as never))
    } finally {
      db.close()
    }
  })
})
