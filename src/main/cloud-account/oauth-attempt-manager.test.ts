import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OAuthAttemptManager } from './oauth-attempt-manager'
import { MAX_AUTH_ATTEMPT_MS } from './cloud-account-limits'

describe('OAuth attempt bounds', () => {
  it('allows exactly one pending attempt and reports its lifetime', () => {
    assert.equal(MAX_AUTH_ATTEMPT_MS, 5 * 60 * 1000)
    const now = 1_000_000
    const manager = new OAuthAttemptManager(() => now)
    const attempt = manager.start('google')
    assert.equal(attempt.provider, 'google')
    assert.equal(attempt.expiresAt - attempt.createdAt, MAX_AUTH_ATTEMPT_MS)
    assert.ok(manager.hasActive())
    assert.throws(() => manager.start('github'), /cloud-auth-in-progress/)
  })

  it('cancel clears the attempt with no network', async () => {
    const manager = new OAuthAttemptManager(() => 1000)
    manager.start('github')
    assert.equal(manager.cancel(), true)
    assert.equal(manager.getActive(), null)
    assert.equal(manager.cancel(), false)
  })

  it('expired attempts clear lazily and allow a fresh start', () => {
    let now = 0
    const manager = new OAuthAttemptManager(() => now)
    manager.start('google')
    now = MAX_AUTH_ATTEMPT_MS + 1
    assert.equal(manager.getActive(), null)
    const fresh = manager.start('github')
    assert.equal(fresh.provider, 'github')
  })

  it('consume is single-use: the second consume sees nothing', () => {
    const manager = new OAuthAttemptManager(() => 5000)
    manager.start('google')
    const first = manager.consumeActive()
    assert.notEqual(first, null)
    assert.equal(manager.consumeActive(), null)
    assert.equal(manager.getActive(), null)
  })
})
