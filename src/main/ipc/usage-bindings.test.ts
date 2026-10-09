import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { AiUsageRepository } from '../usage/ai-usage-repository'
import { AiUsageService } from '../usage/ai-usage-service'
import { createUsageBindings } from './usage'

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(): Promise<{ text: string }> {
    return { text: 'hi' }
  }
}

function openHarness(): { db: DatabaseSync; bindings: ReturnType<typeof createUsageBindings> } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const store = new AiUsageRepository(db)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const service = new AiUsageService(store, registry)
  const heart = new HeartService(new HeartRepository(db), new AiProviderRepository(db), registry)
  return { db, bindings: createUsageBindings(service, heart) }
}

describe('usage IPC bindings', () => {
  it('exposes exactly three local usage channels', () => {
    const { db, bindings } = openHarness()
    try {
      assert.deepEqual(
        [...bindings.map((binding) => binding.channel)].sort(),
        [IPC_CHANNELS.usageGetConfig, IPC_CHANNELS.usageUpdateConfig, IPC_CHANNELS.usageGetSummary].sort()
      )
      const names = bindings.map((binding) => binding.channel).join(' ')
      assert.ok(!names.includes('record'))
      assert.ok(!names.includes('reset'))
      assert.ok(!names.includes('route'))
    } finally {
      db.close()
    }
  })

  it('get/update/summary round-trips with safe errors and no record surface', async () => {
    const { db, bindings } = openHarness()
    try {
      const get = bindings.find((binding) => binding.channel === IPC_CHANNELS.usageGetConfig)
      const update = bindings.find((binding) => binding.channel === IPC_CHANNELS.usageUpdateConfig)
      const summary = bindings.find((binding) => binding.channel === IPC_CHANNELS.usageGetSummary)
      assert.ok(get && update && summary)
      const initial = (await get.invoke(undefined, undefined as never)) as { heartThresholdRoutingEnabled: boolean }
      assert.equal(initial.heartThresholdRoutingEnabled, false)
      const saved = (await update.invoke(
        {
          heartThresholdRoutingEnabled: true,
          limits: [{ providerId: 'openai', model: 'm', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 90 }],
          alternates: []
        },
        undefined as never
      )) as { heartThresholdRoutingEnabled: boolean }
      assert.equal(saved.heartThresholdRoutingEnabled, true)
      const report = (await summary.invoke(undefined, undefined as never)) as {
        models: {
          providerId: string
          model: string
          calls24h: number
          maxCalls24h: number | null
          tokenTelemetryComplete: boolean
        }[]
        truncated: boolean
      }
      assert.equal(report.truncated, false)
      // Configured limits surface their pair even before any traffic.
      assert.equal(report.models.length, 1)
      assert.equal(report.models[0]?.providerId, 'openai')
      assert.equal(report.models[0]?.model, 'm')
      assert.equal(report.models[0]?.calls24h, 0)
      assert.equal(report.models[0]?.maxCalls24h, 10)
      assert.equal(report.models[0]?.tokenTelemetryComplete, true)
      await assert.rejects(update.invoke({ heartThresholdRoutingEnabled: true, limits: [], alternates: [], extra: 1 }, undefined as never))
      await assert.rejects(summary.invoke({ workspaceId: 1 }, undefined as never))
    } finally {
      db.close()
    }
  })

  it('rejects unknown fields without internals', async () => {
    const { db, bindings } = openHarness()
    try {
      const update = bindings.find((binding) => binding.channel === IPC_CHANNELS.usageUpdateConfig)
      assert.ok(update)
      await assert.rejects(
        update.invoke(
          { heartThresholdRoutingEnabled: false, limits: [], alternates: [], apiKey: 'x' },
          undefined as never
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(!error.message.includes('sqlite'))
          assert.ok(!error.message.includes('stark:'))
          return true
        }
      )
    } finally {
      db.close()
    }
  })
})
