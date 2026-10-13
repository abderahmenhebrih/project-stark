import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isModelExecutable, resolveModelEligibility } from './model-eligibility'

/**
 * Main-authoritative model eligibility proof (shared, pure).
 * The renderer NEVER decides executability: omitted/emptied/falsified
 * disabled lists change nothing — only the catalog + compatibility
 * state below matters.
 */
describe('main-authoritative model eligibility', () => {
  it('executable: all 15 hosted builtins and compatible BYOK entries', () => {
    assert.equal(isModelExecutable('builtin:gpt-5.6-luna'), true)
    assert.equal(isModelExecutable('builtin:longcat-2.0'), true)
    assert.equal(isModelExecutable('openai:gpt-4o'), true)
    assert.equal(isModelExecutable('openai:gpt-4o-mini'), true)
    assert.deepEqual(resolveModelEligibility('builtin:gpt-5.6-luna'), { executable: true })
  })

  it('unknown: unlisted builtins and non-chain namespaces', () => {
    for (const id of ['builtin:unknown-x', 'builtin:evil', 'anthropic:claude', 'gpt-4o', '']) {
      assert.equal(isModelExecutable(id), false, id)
      assert.equal(resolveModelEligibility(id).executable, false, id)
    }
  })

  it('incompatible (administratively disabled): known syntax but unrunnable families', () => {
    for (const id of [
      'openai:whisper-1',
      'openai:text-embedding-3-small',
      'openai:dall-e-3',
      'openai:text-davinci-003',
      'openai:realtime-model'
    ]) {
      assert.equal(isModelExecutable(id), false, id)
      const resolved = resolveModelEligibility(id)
      assert.equal(resolved.executable, false, id)
      if (!resolved.executable) {
        assert.equal(resolved.reason, 'incompatible', id)
      }
    }
  })

  it('malformed inputs fail closed (never executable)', () => {
    for (const bad of [null, undefined, 7, '', 'x'.repeat(129), 'a\0b', 'openai:bad slug']) {
      assert.equal(isModelExecutable(bad), false, JSON.stringify(bad))
    }
  })

  it('disabled != capability-unsupported: LongCat executes (capability filtered per phase, not rejected here)', () => {
    // Structured/vision gaps are per-phase failover (eligibleLoopLinkModels),
    // not validation rejection — eligibility stays executable.
    assert.equal(isModelExecutable('builtin:longcat-2.0'), true)
  })
})
