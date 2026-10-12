import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageService } from './ai-usage-service'
import { ProviderRegistry } from '../ai/provider-adapter'

function openRepo(): { db: DatabaseSync; repo: AiUsageRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, repo: new AiUsageRepository(db) }
}

function seedScope(db: DatabaseSync): void {
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 's', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'other', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.prepare(
    "INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, 'running', 1, 1)"
  ).run()
}

describe('per-session usage', () => {
  it('aggregates one session with provider-reported counts only', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      const first = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1000
      })
      repo.finalizeSuccess(first.id, { inputTokens: 100, outputTokens: 50, totalTokens: 150, latencyMs: 5, now: 1005 })
      const second = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1010
      })
      repo.finalizeSuccess(second.id, { inputTokens: 200, outputTokens: 60, totalTokens: 260, latencyMs: 5, now: 1015 })
      // Another session's traffic must not leak in.
      const other = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 2, runId: 1, now: 1020
      })
      repo.finalizeSuccess(other.id, { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998, latencyMs: 5, now: 1025 })
      const rows = repo.summarizeSessionWindow(1, 0)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.calls, 2)
      assert.equal(rows[0]?.inputTokens, 300)
      assert.equal(rows[0]?.outputTokens, 110)
      assert.equal(rows[0]?.totalTokens, 410)
      assert.equal(repo.latestSessionInputTokens(1, 0), 200)
      assert.equal(repo.latestSessionInputTokens(2, 0), 9999)
      assert.equal(repo.latestSessionInputTokens(999, 0), null)
      assert.deepEqual(repo.summarizeSessionWindow(999, 0), [])
    } finally {
      db.close()
    }
  })

  it('serves honest session summaries with nulls for unreported values', () => {
    const { db, repo } = openRepo()
    try {
      seedScope(db)
      // Event timestamps are fixed test values: pin `now` inside the
      // 24-hour window so the service aggregation sees them.
      const service = new AiUsageService(repo, new ProviderRegistry(), { now: () => 2000 })
      const empty = service.getSessionSummary(1)
      assert.deepEqual(empty, {
        sessionId: 1,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latestInputTokens: null,
        telemetryComplete: true
      })
      const reserved = repo.reserveEvent({
        providerId: 'openai', model: 'm', operation: 'ask', role: 'ask',
        workspaceId: 1, sessionId: 1, runId: 1, now: 1000
      })
      // Provider reported nothing usable: counts exist, tokens stay null.
      repo.finalizeSuccess(reserved.id, { inputTokens: null, outputTokens: null, totalTokens: null, latencyMs: 5, now: 1005 })
      const partial = service.getSessionSummary(1)
      assert.equal(partial.calls, 1)
      assert.equal(partial.inputTokens, null)
      assert.equal(partial.latestInputTokens, null)
      assert.equal(partial.telemetryComplete, false)
      assert.throws(() => service.getSessionSummary(0))
      assert.throws(() => service.getSessionSummary('1'))
    } finally {
      db.close()
    }
  })
})
