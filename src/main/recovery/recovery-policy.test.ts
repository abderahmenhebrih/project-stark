import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RECOVERABLE_CATEGORIES,
  decideRecovery,
  failureCategoryFor,
  failureCategoryLabel,
  isRecoverableCategory
} from './recovery-policy'
import {
  ProviderForbiddenError,
  ProviderGenericError,
  ProviderInvalidCredentialError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderStructuredOutputUnsupportedError,
  ProviderTimeoutError
} from '../ai/errors'

describe('recovery policy matrix', () => {
  const recoverable: { category: string; error: unknown }[] = [
    { category: 'provider-rate-limit', error: new ProviderRateLimitedError() },
    { category: 'provider-network', error: new ProviderNetworkError() },
    { category: 'provider-timeout', error: new ProviderTimeoutError() },
    { category: 'provider-unavailable', error: new ProviderGenericError() },
    { category: 'model-unavailable', error: new ProviderModelUnavailableError() },
    { category: 'structured-output-unsupported', error: new ProviderStructuredOutputUnsupportedError() }
  ]

  it('exposes exactly the six stable recoverable categories', () => {
    assert.deepEqual([...RECOVERABLE_CATEGORIES].sort(), [
      'model-unavailable',
      'provider-network',
      'provider-rate-limit',
      'provider-timeout',
      'provider-unavailable',
      'structured-output-unsupported'
    ])
  })

  it('maps typed provider errors to stable categories', () => {
    for (const entry of recoverable) {
      assert.equal(failureCategoryFor(entry.error), entry.category)
      assert.ok(isRecoverableCategory(entry.category))
    }
  })

  it('never maps auth/permission/unknown to recoverable', () => {
    assert.equal(failureCategoryFor(new ProviderInvalidCredentialError()), null)
    assert.equal(failureCategoryFor(new ProviderForbiddenError()), null)
    assert.equal(failureCategoryFor(new Error('timeout in plain text')), null)
    assert.equal(failureCategoryFor('rate limit'), null)
    assert.equal(failureCategoryFor(null), null)
    assert.equal(isRecoverableCategory('invalid credential'), false)
    assert.equal(isRecoverableCategory(null), false)
  })

  it('off never recovers for any category', () => {
    for (const entry of recoverable) {
      assert.equal(
        decideRecovery({ mode: 'off', failureCategory: entry.category, isRecoveryTarget: false, existingEvent: false }),
        'none'
      )
    }
    assert.equal(
      decideRecovery({ mode: 'off', failureCategory: null, isRecoveryTarget: false, existingEvent: false }),
      'none'
    )
  })

  it('handoff recovers only for recoverable categories', () => {
    for (const entry of recoverable) {
      assert.equal(
        decideRecovery({ mode: 'handoff', failureCategory: entry.category, isRecoveryTarget: false, existingEvent: false }),
        'handoff'
      )
    }
    for (const bad of [null, 'invalid credential', 'permission', 'timeout']) {
      assert.equal(
        decideRecovery({ mode: 'handoff', failureCategory: bad, isRecoveryTarget: false, existingEvent: false }),
        'none'
      )
    }
  })

  it('auto_once recovers only for recoverable categories', () => {
    for (const entry of recoverable) {
      assert.equal(
        decideRecovery({ mode: 'auto_once', failureCategory: entry.category, isRecoveryTarget: false, existingEvent: false }),
        'auto_once'
      )
    }
    for (const bad of [null, 'invalid credential', 'permission', 'provider-rate-limit-extra']) {
      assert.equal(
        decideRecovery({ mode: 'auto_once', failureCategory: bad, isRecoveryTarget: false, existingEvent: false }),
        'none'
      )
    }
  })

  it('recovery targets never auto-recover (depth <= 1)', () => {
    for (const mode of ['off', 'handoff', 'auto_once'] as const) {
      for (const entry of recoverable) {
        assert.equal(
          decideRecovery({ mode, failureCategory: entry.category, isRecoveryTarget: true, existingEvent: false }),
          'none'
        )
      }
    }
  })

  it('existing events never create a second handoff', () => {
    for (const mode of ['off', 'handoff', 'auto_once'] as const) {
      for (const entry of recoverable) {
        assert.equal(
          decideRecovery({ mode, failureCategory: entry.category, isRecoveryTarget: false, existingEvent: true }),
          'none'
        )
      }
    }
  })

  it('labels categories without leaking bodies', () => {
    assert.equal(failureCategoryLabel('provider-rate-limit'), 'Rate limit')
    assert.equal(failureCategoryLabel('provider-network'), 'Network')
    assert.equal(failureCategoryLabel('provider-timeout'), 'Timeout')
    assert.equal(failureCategoryLabel('provider-unavailable'), 'Provider unavailable')
    assert.equal(failureCategoryLabel('model-unavailable'), 'Model unavailable')
    assert.equal(failureCategoryLabel('structured-output-unsupported'), 'Structured output unsupported')
    assert.equal(failureCategoryLabel('weird'), 'Provider failure')
  })

  it('pure policy performs zero provider calls (static)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'recovery', 'recovery-policy.ts'), 'utf8')
    for (const forbidden of ['generateText', 'generateStructured', 'fetch(', 'OpenAI', 'XMLHttpRequest', 'while (', 'for (']) {
      // The policy file must not contain provider-call or loop shapes.
      // `for (` appears only in the exhaustive test loops of this file,
      // never in the policy itself — so check the policy source.
      if (forbidden === 'for (') {
        // Allow zero occurrences: policy has no candidate iteration.
        assert.ok(!source.includes('for ('), 'policy must not iterate providers')
      } else if (forbidden === 'while (') {
        assert.ok(!source.includes('while ('), 'policy must not loop')
      } else {
        assert.ok(!source.includes(forbidden), `policy must not contain ${forbidden}`)
      }
    }
  })
})
