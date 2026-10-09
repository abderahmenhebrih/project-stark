import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageTracker, failureCategoryOf } from './ai-usage-tracker'
import {
  ProviderGenericError,
  ProviderInvalidCredentialError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  ProviderForbiddenError,
  ProviderCredentialMissingError,
  ProviderStructuredOutputUnsupportedError
} from '../ai/errors'

function openTracker(): { db: DatabaseSync; repo: AiUsageRepository; tracker: AiUsageTracker } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 's', 1, 1)")
  const repo = new AiUsageRepository(db)
  return { db, repo, tracker: new AiUsageTracker(repo) }
}

const META = {
  operation: 'ask',
  role: 'ask' as const,
  providerId: 'openai',
  model: 'm',
  workspaceId: 1,
  sessionId: 1,
  runId: null
}

describe('usage tracker', () => {
  it('records one success event with reported usage and returns the result', async () => {
    const { db, repo, tracker } = openTracker()
    try {
      let calls = 0
      const result = await tracker.track(META, async () => {
        calls += 1
        return { text: 'hi', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
      })
      assert.deepEqual(result, { text: 'hi', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
      assert.equal(calls, 1)
      const rows = repo.summarizeWindow(0)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.successes, 1)
      assert.equal(rows[0]?.totalTokens, 7)
    } finally {
      db.close()
    }
  })

  it('records null usage when the provider reports nothing (never estimates)', async () => {
    const { db, repo, tracker } = openTracker()
    try {
      await tracker.track(META, async () => ({ text: 'hi' }))
      const rows = repo.summarizeWindow(0)
      assert.equal(rows[0]?.successes, 1)
      assert.equal(rows[0]?.totalTokens, null)
      assert.equal(rows[0]?.successesWithTotalTokens, 0)
    } finally {
      db.close()
    }
  })

  it('records failures with safe categories and rethrows the original error', async () => {
    const { db, repo, tracker } = openTracker()
    try {
      const failure = new ProviderRateLimitedError()
      await assert.rejects(tracker.track(META, async () => {
        throw failure
      }))
      const rows = repo.summarizeWindow(0)
      assert.equal(rows[0]?.failures, 1)
      assert.equal(rows[0]?.rateLimitFailures, 1)
    } finally {
      db.close()
    }
  })

  it('invokes the provider exactly once even when telemetry persistence fails', async () => {
    const { db, repo, tracker } = openTracker()
    try {
      let calls = 0
      // Break the ledger: drop the events table so reserve always throws.
      db.exec('DROP TABLE ai_usage_events')
      const result = await tracker.track(META, async () => {
        calls += 1
        return { text: 'still works' }
      })
      assert.deepEqual(result, { text: 'still works' })
      assert.equal(calls, 1)
      void repo
    } finally {
      db.close()
    }
  })

  it('returns success when finalization fails (no success-to-retry conversion)', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const repo = new AiUsageRepository(db)
      let calls = 0
      // Reserve succeeds; break finalization by dropping the table mid-flight.
      const tracker = new AiUsageTracker(repo)
      const result = await tracker.track(META, async () => {
        calls += 1
        db.exec('DROP TABLE ai_usage_events')
        return { text: 'ok' }
      })
      assert.deepEqual(result, { text: 'ok' })
      assert.equal(calls, 1)
    } finally {
      db.close()
    }
  })

  it('maps failures to safe categories without bodies or keys', () => {
    assert.equal(failureCategoryOf(new ProviderRateLimitedError()), 'provider-rate-limit')
    assert.equal(failureCategoryOf(new ProviderTimeoutError()), 'provider-timeout')
    assert.equal(failureCategoryOf(new ProviderNetworkError()), 'provider-network')
    assert.equal(failureCategoryOf(new ProviderModelUnavailableError()), 'model-unavailable')
    assert.equal(failureCategoryOf(new ProviderStructuredOutputUnsupportedError()), 'model-unavailable')
    assert.equal(failureCategoryOf(new ProviderInvalidCredentialError()), 'credential')
    assert.equal(failureCategoryOf(new ProviderCredentialMissingError()), 'credential')
    assert.equal(failureCategoryOf(new ProviderForbiddenError()), 'permission')
    assert.equal(failureCategoryOf(new ProviderGenericError()), 'other-safe-category')
    assert.equal(failureCategoryOf(new Error('boom')), 'other-safe-category')
  })
})
