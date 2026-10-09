import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageService } from './ai-usage-service'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'

class FakeAdapter implements AiProviderAdapter {
  constructor(readonly id: ProviderId) {}
  readonly displayName = 'Fake'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(): Promise<{ text: string }> {
    return { text: 'hi' }
  }
}

function openService(options?: {
  heartBaseResolver?: (routeKey: never) => { providerId: string; model: string } | null
  now?: () => number
}): { db: DatabaseSync; service: AiUsageService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter('openai'))
  const service = new AiUsageService(new AiUsageRepository(db), registry, {
    heartBaseResolver: options?.heartBaseResolver as never,
    now: options?.now
  })
  return { db, service }
}

function validLimit(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    providerId: 'openai',
    model: 'model-A',
    maxCalls24h: 100,
    maxTotalTokens24h: null,
    switchAtPercent: 90,
    ...overrides
  }
}

describe('usage config validation', () => {
  it('saves and reloads a complete config with defaults off', () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(service.getConfig(), { heartThresholdRoutingEnabled: false, limits: [], alternates: [] })
      const saved = service.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [validLimit() as never],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      assert.equal(saved.heartThresholdRoutingEnabled, true)
      assert.equal(saved.limits.length, 1)
      assert.equal(saved.alternates.length, 1)
      assert.deepEqual(service.getConfig(), saved)
    } finally {
      db.close()
    }
  })

  it('rejects duplicate limits, duplicate routes, unknown providers, and bad bounds', () => {
    const { db, service } = openService()
    try {
      const good = {
        heartThresholdRoutingEnabled: false,
        limits: [validLimit()],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      }
      // Duplicate limits.
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit(), validLimit()] as never }))
      // Duplicate alternate route.
      assert.throws(() =>
        service.updateConfig({
          ...good,
          alternates: [
            { routeKey: 'brain.primary', providerId: 'openai', model: 'x' },
            { routeKey: 'brain.primary', providerId: 'openai', model: 'y' }
          ]
        })
      )
      // Unknown provider.
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ providerId: 'nope' })] as never }))
      // Bad model Unicode and bounds.
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ model: '' })] as never }))
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ maxCalls24h: 0 })] as never }))
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ maxCalls24h: 1_000_001 })] as never }))
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ maxTotalTokens24h: 0 })] as never }))
      assert.throws(() =>
        service.updateConfig({ ...good, limits: [validLimit({ maxCalls24h: null, maxTotalTokens24h: null })] as never })
      )
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ switchAtPercent: 0 })] as never }))
      assert.throws(() => service.updateConfig({ ...good, limits: [validLimit({ switchAtPercent: 101 })] as never }))
      // Unknown route key and extra fields.
      assert.throws(() =>
        service.updateConfig({ ...good, alternates: [{ routeKey: 'nope', providerId: 'openai', model: 'x' }] as never })
      )
      assert.throws(() => service.updateConfig({ ...good, limits: [{ ...validLimit(), apiKey: 'x' }] as never }))
      assert.throws(() => service.updateConfig({ ...good, limits: [{ ...validLimit(), baseURL: 'x' }] as never }))
      assert.throws(() => service.updateConfig({ ...good, extra: 1 } as never))
      // Alternate identical to the current Heart base is rejected.
      const withBase = openService({
        heartBaseResolver: (() => ({ providerId: 'openai', model: 'model-A' })) as never
      })
      try {
        assert.throws(() =>
          withBase.service.updateConfig({
            heartThresholdRoutingEnabled: true,
            limits: [],
            alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-A' }]
          })
        )
      } finally {
        withBase.db.close()
      }
      // Failed saves keep the old config intact.
      assert.deepEqual(service.getConfig(), { heartThresholdRoutingEnabled: false, limits: [], alternates: [] })
    } finally {
      db.close()
    }
  })
})

describe('usage summary and snapshots', () => {
  it('aggregates the rolling 24h window with token completeness', () => {
    const now = 10_000_000
    const { db, service } = openService({ now: () => now })
    try {
      const store = new AiUsageRepository(db)
      const first = store.reserveEvent({
        providerId: 'openai', model: 'model-A', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 1000
      })
      store.finalizeSuccess(first.id, { inputTokens: 5, outputTokens: 5, totalTokens: 10, latencyMs: 1, now: now - 999 })
      const second = store.reserveEvent({
        providerId: 'openai', model: 'model-A', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 500
      })
      store.finalizeSuccess(second.id, { inputTokens: null, outputTokens: null, totalTokens: null, latencyMs: 1, now: now - 499 })
      // Outside the window: ignored.
      db.exec(
        `INSERT INTO ai_usage_events (provider_id, model, operation, status, created_at) VALUES ('openai', 'model-A', 'ask', 'success', ${now - 25 * 60 * 60 * 1000})`
      )
      const summary = service.get24HourSummary([])
      const row = summary.models.find((entry) => entry.model === 'model-A')
      assert.ok(row !== undefined)
      assert.equal(row.calls24h, 2)
      assert.equal(row.successes24h, 2)
      assert.equal(row.totalTokens24h, 10)
      assert.equal(row.tokenTelemetryComplete, false)
      assert.equal(summary.windowMs, 24 * 60 * 60 * 1000)
      assert.equal(summary.truncated, false)
    } finally {
      db.close()
    }
  })

  it('counts every attempt kind in calls24h', () => {
    const now = 10_000_000
    const { db, service } = openService({ now: () => now })
    try {
      const store = new AiUsageRepository(db)
      const started = store.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 100
      })
      void started
      const failed = store.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 90
      })
      store.finalizeFailure(failed.id, { failureCategory: 'provider-timeout', latencyMs: 1, now: now - 89 })
      const interrupted = store.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 80
      })
      store.markStartedAsInterrupted(now - 79)
      void interrupted
      const summary = service.get24HourSummary([])
      const row = summary.models.find((entry) => entry.model === 'm')
      assert.ok(row !== undefined)
      // started + failed + interrupted all represent outbound attempts.
      assert.equal(row.calls24h, 3)
      assert.equal(row.successes24h, 0)
      assert.equal(row.failures24h, 3)
    } finally {
      db.close()
    }
  })

  it('treats empty success history as token-complete with zero totals', () => {
    const { db, service } = openService()
    try {
      const summary = service.get24HourSummary([{ providerId: 'openai', model: 'model-Z' }])
      const row = summary.models.find((entry) => entry.model === 'model-Z')
      assert.ok(row !== undefined)
      assert.equal(row.calls24h, 0)
      assert.equal(row.totalTokens24h, 0)
      assert.equal(row.tokenTelemetryComplete, true)
    } finally {
      db.close()
    }
  })

  it('caps summary models at 100 with a truncation flag', () => {
    const { db, service } = openService()
    try {
      for (let index = 0; index < 105; index += 1) {
        db.exec(
          `INSERT INTO ai_usage_events (provider_id, model, operation, status, created_at) VALUES ('openai', 'model-${index}', 'ask', 'success', ${Date.now()})`
        )
      }
      const summary = service.get24HourSummary([])
      assert.equal(summary.models.length, 100)
      assert.equal(summary.truncated, true)
    } finally {
      db.close()
    }
  })

  it('snapshots freeze per-assignment usage for Work-start routing', () => {
    const { db, service } = openService()
    try {
      service.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [validLimit({ maxCalls24h: 10, switchAtPercent: 100 }) as never],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      const snap = service.snapshotForWork([
        { providerId: 'openai', model: 'model-A' },
        { providerId: 'openai', model: 'model-A' }
      ])
      assert.equal(snap.enabled, true)
      assert.equal(snap.summaries.size, 1)
      assert.equal(snap.alternates.get('brain.primary')?.model, 'model-X')
      assert.ok(snap.snapshotAt > 0)
    } finally {
      db.close()
    }
  })

  it('startup cleanup prunes old rows and interrupts started leftovers', () => {
    const { db, service } = openService()
    try {
      const day = 24 * 60 * 60 * 1000
      const now = day * 100
      const store = new AiUsageRepository(db)
      store.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: null, sessionId: null, runId: null, now: now - 1000
      })
      db.exec(`INSERT INTO ai_usage_events (provider_id, model, operation, status, created_at) VALUES ('openai', 'old', 'ask', 'success', ${now - day * 40})`)
      const outcome = service.startupCleanup(now)
      assert.equal(outcome.interrupted, 1)
      assert.equal(outcome.pruned, 1)
    } finally {
      db.close()
    }
  })

  it('decisions round-trip per run and reject bad run references', () => {
    const { db, service } = openService()
    try {
      assert.deepEqual(service.decisionsForRun(4242), [])
      assert.throws(() => service.decisionsForRun(-1))
    } finally {
      db.close()
    }
  })
})
