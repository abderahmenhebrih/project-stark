import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiUsageRepository } from './ai-usage-repository'

function openRepo(): { db: DatabaseSync; repo: AiUsageRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, repo: new AiUsageRepository(db) }
}

function seedScope(db: DatabaseSync): { runId: number } {
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 's', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  const run = db
    .prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, 'running', 1, 1)")
    .run()
  const id = typeof run.lastInsertRowid === 'bigint' ? Number(run.lastInsertRowid) : run.lastInsertRowid
  return { runId: id as number }
}

describe('ai usage repository events', () => {
  it('reserves started events and finalizes success with reported usage', () => {
    const { db, repo } = openRepo()
    try {
      const { runId } = seedScope(db)
      const { id } = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId, now: 1000
      })
      repo.finalizeSuccess(id, { inputTokens: 10, outputTokens: 20, totalTokens: 30, latencyMs: 5, now: 1005 })
      const rows = repo.summarizeWindow(0)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.calls, 1)
      assert.equal(rows[0]?.successes, 1)
      assert.equal(rows[0]?.totalTokens, 30)
      assert.equal(rows[0]?.successesWithTotalTokens, 1)
    } finally {
      db.close()
    }
  })

  it('finalizes failures with safe categories and counts rate limits', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      const first = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'brain_plan', role: 'brain',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1000
      })
      repo.finalizeFailure(first.id, { failureCategory: 'provider-rate-limit', latencyMs: 5, now: 1005 })
      const second = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'worker', role: 'worker',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1010
      })
      repo.finalizeFailure(second.id, { failureCategory: 'provider-timeout', latencyMs: 5, now: 1015 })
      const rows = repo.summarizeWindow(0)
      assert.equal(rows[0]?.calls, 2)
      assert.equal(rows[0]?.successes, 0)
      assert.equal(rows[0]?.failures, 2)
      assert.equal(rows[0]?.rateLimitFailures, 1)
      assert.equal(rows[0]?.totalTokens, null)
    } finally {
      db.close()
    }
  })

  it('stores no prompt, result, key, or body content', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      const { id } = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1000
      })
      repo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: 1001 })
      const columns = db.prepare('PRAGMA table_info(ai_usage_events)').all() as { name: string }[]
      const names = columns.map((column) => column.name).join(' ')
      for (const forbidden of ['prompt', 'result', 'content', 'key', 'body', 'header', 'text']) {
        assert.ok(!names.includes(forbidden), `usage events must not store ${forbidden}`)
      }
    } finally {
      db.close()
    }
  })

  it('marks started leftovers interrupted and prunes old rows at startup', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      const day = 24 * 60 * 60 * 1000
      const now = day * 100
      repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: now - 1000
      })
      assert.equal(repo.markStartedAsInterrupted(now).interrupted, 1)
      // 40-day-old row is pruned; 10-day-old row is preserved.
      db.exec(
        `INSERT INTO ai_usage_events (provider_id, model, operation, status, created_at) VALUES ('openai', 'old', 'ask', 'success', ${now - day * 40})`
      )
      db.exec(
        `INSERT INTO ai_usage_events (provider_id, model, operation, status, created_at) VALUES ('openai', 'new', 'ask', 'success', ${now - day * 10})`
      )
      assert.equal(repo.deleteOlderThan(now - day * 31).deleted, 1)
      const remaining = db.prepare("SELECT model FROM ai_usage_events WHERE model = 'new'").get()
      assert.ok(remaining !== undefined)
    } finally {
      db.close()
    }
  })

  it('supports injected reserve/finalize faults for telemetry-failure tests', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      assert.throws(() =>
        repo.reserveEvent(
          { providerId: 'openai', model: 'm', operation: 'ask', role: 'ask', workspaceId: 1, sessionId: 1, runId: 1, now: 1 },
          { throwBeforeInsert: true }
        )
      )
      const { id } = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1
      })
      assert.throws(() =>
        repo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: 2 }, { throwBeforeUpdate: true })
      )
      assert.throws(() =>
        repo.finalizeFailure(id, { failureCategory: 'provider-timeout', latencyMs: 1, now: 2 }, { throwBeforeUpdate: true })
      )
    } finally {
      db.close()
    }
  })
})

describe('ai usage repository config', () => {
  it('replaces settings, limits, and alternates atomically', () => {
    const { db, repo } = openRepo()
    try {
      assert.equal(repo.findSettings(), undefined)
      repo.replaceConfig({
        thresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'a', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'x' }],
        now: 1000
      })
      assert.equal(repo.findSettings()?.thresholdRoutingEnabled, true)
      assert.equal(repo.listLimits().length, 1)
      assert.equal(repo.listAlternates().length, 1)
      // Replacement removes stale rows.
      repo.replaceConfig({ thresholdRoutingEnabled: false, limits: [], alternates: [], now: 2000 })
      assert.equal(repo.findSettings()?.thresholdRoutingEnabled, false)
      assert.equal(repo.listLimits().length, 0)
      assert.equal(repo.listAlternates().length, 0)
    } finally {
      db.close()
    }
  })

  it('rolls back the whole config on injected fault', () => {
    const { db, repo } = openRepo()
    try {
      repo.replaceConfig({
        thresholdRoutingEnabled: false,
        limits: [
          { providerId: 'openai', model: 'a', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 90 },
          { providerId: 'openai', model: 'b', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 90 }
        ],
        alternates: [],
        now: 1000
      })
      assert.throws(() =>
        repo.replaceConfig(
          {
            thresholdRoutingEnabled: true,
            limits: [
              { providerId: 'openai', model: 'c', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 90 },
              { providerId: 'openai', model: 'd', maxCalls24h: 10, maxTotalTokens24h: null, switchAtPercent: 90 }
            ],
            alternates: [],
            now: 2000
          },
          { failAfterLimits: 0 }
        )
      )
      assert.equal(repo.findSettings()?.thresholdRoutingEnabled, false)
      assert.deepEqual(
        repo.listLimits().map((row) => row.model).sort(),
        ['a', 'b']
      )
    } finally {
      db.close()
    }
  })

  it('persists route decisions immutably per run role', () => {
    const { db, repo } = openRepo()
    try {
      const { runId } = seedScope(db)
      const id = repo.insertDecision({
        runId,
        role: 'brain',
        routeKey: 'brain.primary',
        baseProviderId: 'openai',
        baseModel: 'a',
        selectedProviderId: 'openai',
        selectedModel: 'x',
        decision: 'threshold_alternate',
        calls24h: 90,
        tokens24h: null,
        tokenTelemetryComplete: true,
        maxCalls24h: 100,
        maxTotalTokens24h: null,
        switchAtPercent: 90,
        callsTriggered: true,
        tokensTriggered: false,
        snapshotAt: 500,
        now: 1000
      })
      assert.ok(id > 0)
      const decisions = repo.findDecisionsByRun(runId)
      assert.equal(decisions.length, 1)
      assert.equal(decisions[0]?.decision, 'threshold_alternate')
      assert.equal(decisions[0]?.callsTriggered, true)
      assert.equal(decisions[0]?.tokenTelemetryComplete, true)
      // Historical runs without rows load as empty.
      assert.deepEqual(repo.findDecisionsByRun(runId + 999), [])
    } finally {
      db.close()
    }
  })
})
