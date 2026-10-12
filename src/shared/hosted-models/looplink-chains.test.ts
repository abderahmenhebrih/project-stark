import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_LOOPLINK_CHAIN_MODELS,
  filterLoopLinkChainForCapability,
  isKnownLoopLinkModelId,
  loopLinkEntryAssignment,
  validateLoopLinkChain
} from './looplink-chains'

/**
 * LoopLink chain contract proof: ordered enabled ids, max 5,
 * no duplicates, exact known ids only (15 Free builtins + bounded
 * openai:* entries — never arbitrary upstream ids), plus
 * capability-aware filtering (structured, vision).
 */

const A = 'builtin:gpt-5.6-luna'
const B = 'builtin:claude-haiku-5.5'
const C = 'builtin:deepseek-v4.1-flash'

describe('looplink chain validation', () => {
  it('accepts ordered enabled chains up to 5', () => {
    assert.equal(MAX_LOOPLINK_CHAIN_MODELS, 5)
    const valid = validateLoopLinkChain([A, B, C])
    assert.equal(valid.ok, true)
    if (valid.ok) {
      assert.deepEqual([...valid.chain], [A, B, C])
    }
  })

  it('rejects malformed chains', () => {
    assert.equal(validateLoopLinkChain('nope').ok, false)
    assert.equal(validateLoopLinkChain([]).ok, false)
    if (!validateLoopLinkChain([]).ok) {
      const empty = validateLoopLinkChain([])
      assert.equal(empty.ok === false && empty.reason === 'empty', true)
    }
    assert.equal(validateLoopLinkChain([A, A]).ok, false)
    assert.equal(validateLoopLinkChain([A, B, C, A, B, C]).ok, false)
    assert.equal(validateLoopLinkChain([A, '']).ok, false)
    assert.equal(validateLoopLinkChain([A, 'builtin:unknown-model']).ok, false)
  })

  it('rejects arbitrary upstream injection', () => {
    for (const bad of [
      'openai/gpt-5.6-luna',
      'anthropic/claude-haiku-5.5',
      'openrouter:openai/gpt-5.6-luna',
      'builtin:evil-proxy',
      'stark:gpt-5.6-luna',
      'gpt-4o'
    ]) {
      assert.equal(isKnownLoopLinkModelId(bad), false, `${bad} must be rejected`)
      assert.equal(validateLoopLinkChain([bad]).ok, false)
    }
  })

  it('accepts bounded openai:* connected entries, rejects malformed ones', () => {
    assert.equal(isKnownLoopLinkModelId('openai:gpt-4o'), true)
    assert.equal(validateLoopLinkChain(['openai:gpt-4o', A]).ok, true)
    for (const bad of ['openai:', 'openai:gpt 4o', 'openai:gpt-4o!']) {
      assert.equal(isKnownLoopLinkModelId(bad), false, `${bad} must be rejected`)
    }
  })

  it('routes builtin:* to stark and openai:* to BYOK', () => {
    assert.deepEqual(loopLinkEntryAssignment(A), { providerId: 'stark', model: A })
    assert.deepEqual(loopLinkEntryAssignment('openai:gpt-4o'), { providerId: 'openai', model: 'gpt-4o' })
    assert.equal(loopLinkEntryAssignment('builtin:nope'), null)
  })
})

describe('looplink capability-aware filtering', () => {
  it('skips structured-incapable models for structured phases', () => {
    const chain = ['builtin:longcat-2.0', A, B] as const
    const eligible = filterLoopLinkChainForCapability([...chain], { needsStructured: true, needsVision: false })
    assert.ok(!eligible.includes('builtin:longcat-2.0'), 'longcat advertises no structured outputs')
    assert.deepEqual([...eligible], [A, B])
  })

  it('skips vision-incapable models when vision is required', () => {
    const chain = ['builtin:nemotron-3.5-lightning', A] as const
    const eligible = filterLoopLinkChainForCapability([...chain], { needsStructured: false, needsVision: true })
    assert.deepEqual([...eligible], [A])
  })

  it('preserves UI order', () => {
    const eligible = filterLoopLinkChainForCapability([B, A, C], { needsStructured: false, needsVision: false })
    assert.deepEqual([...eligible], [B, A, C])
  })
})
