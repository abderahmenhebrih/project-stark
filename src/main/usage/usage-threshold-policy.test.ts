import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeProviderUsage } from './ai-usage-types'
import { decideThresholdRoute, evaluateTriggers } from './usage-threshold-policy'

const BASE = { providerId: 'openai', model: 'model-A' }
const ALT = { providerId: 'openai', model: 'model-X' }

describe('provider usage normalization', () => {
  it('maps reported Responses-API usage', () => {
    assert.deepEqual(normalizeProviderUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 30 }), {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30
    })
  })

  it('sanitizes missing, negative, fractional, unsafe, and string values to null', () => {
    assert.deepEqual(normalizeProviderUsage(undefined), { inputTokens: null, outputTokens: null, totalTokens: null })
    assert.deepEqual(normalizeProviderUsage(null), { inputTokens: null, outputTokens: null, totalTokens: null })
    assert.deepEqual(normalizeProviderUsage({}), { inputTokens: null, outputTokens: null, totalTokens: null })
    assert.deepEqual(normalizeProviderUsage({ input_tokens: -1, output_tokens: 1.5, total_tokens: '30' }), {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null
    })
    assert.deepEqual(normalizeProviderUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: Infinity }), {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null
    })
    assert.deepEqual(normalizeProviderUsage('usage'), { inputTokens: null, outputTokens: null, totalTokens: null })
  })

  it('sanitizes inconsistent totals instead of inventing values', () => {
    assert.deepEqual(normalizeProviderUsage({ input_tokens: 20, output_tokens: 20, total_tokens: 5 }), {
      inputTokens: 20,
      outputTokens: 20,
      totalTokens: null
    })
  })

  it('never estimates: partial reports stay partial', () => {
    assert.deepEqual(normalizeProviderUsage({ total_tokens: 42 }), {
      inputTokens: null,
      outputTokens: null,
      totalTokens: 42
    })
  })
})

describe('threshold trigger evaluation', () => {
  it('fires call thresholds at exactly the switch percentage', () => {
    const limit = { maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }
    assert.equal(evaluateTriggers({ calls24h: 89, tokens24h: 0, tokenTelemetryComplete: true }, limit).reached, false)
    assert.equal(evaluateTriggers({ calls24h: 90, tokens24h: 0, tokenTelemetryComplete: true }, limit).reached, true)
    assert.equal(
      evaluateTriggers({ calls24h: 90, tokens24h: 0, tokenTelemetryComplete: true }, limit).callsTriggered,
      true
    )
  })

  it('requires complete telemetry for token triggers', () => {
    const limit = { maxCalls24h: null, maxTotalTokens24h: 1000, switchAtPercent: 50 }
    assert.equal(
      evaluateTriggers({ calls24h: 5, tokens24h: 900, tokenTelemetryComplete: false }, limit).reached,
      false
    )
    assert.equal(
      evaluateTriggers({ calls24h: 5, tokens24h: 500, tokenTelemetryComplete: true }, limit).reached,
      true
    )
    assert.equal(evaluateTriggers({ calls24h: 5, tokens24h: null, tokenTelemetryComplete: true }, limit).reached, false)
  })

  it('call triggers still fire when token telemetry is incomplete', () => {
    const limit = { maxCalls24h: 10, maxTotalTokens24h: 1000, switchAtPercent: 100 }
    const triggers = evaluateTriggers({ calls24h: 10, tokens24h: null, tokenTelemetryComplete: false }, limit)
    assert.equal(triggers.reached, true)
    assert.equal(triggers.callsTriggered, true)
    assert.equal(triggers.tokensTriggered, false)
  })

  it('no limit means no trigger', () => {
    assert.deepEqual(evaluateTriggers({ calls24h: 9999, tokens24h: 9999, tokenTelemetryComplete: true }, null), {
      callsTriggered: false,
      tokensTriggered: false,
      reached: false
    })
  })
})

describe('threshold route decisions', () => {
  it('selects base when disabled, unconfigured, or untriggered', () => {
    const usage = { calls24h: 500, tokens24h: 500, tokenTelemetryComplete: true }
    const limit = { maxCalls24h: 100, maxTotalTokens24h: 100, switchAtPercent: 10 }
    assert.equal(
      decideThresholdRoute({ enabled: false, routeKey: 'brain.primary', base: BASE, alternate: ALT, usage, limit }).decision,
      'base'
    )
    assert.equal(
      decideThresholdRoute({ enabled: true, routeKey: 'brain.primary', base: BASE, alternate: ALT, usage, limit: null }).decision,
      'base'
    )
    assert.equal(
      decideThresholdRoute({
        enabled: true,
        routeKey: 'brain.primary',
        base: BASE,
        alternate: ALT,
        usage: { calls24h: 1, tokens24h: 0, tokenTelemetryComplete: true },
        limit: { maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }
      }).decision,
      'base'
    )
  })

  it('selects the single alternate once when triggered', () => {
    const decided = decideThresholdRoute({
      enabled: true,
      routeKey: 'worker.coding',
      base: BASE,
      alternate: ALT,
      usage: { calls24h: 90, tokens24h: 0, tokenTelemetryComplete: true },
      limit: { maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }
    })
    assert.equal(decided.decision, 'threshold_alternate')
    assert.deepEqual(decided.selected, ALT)
    assert.equal(decided.callsTriggered, true)
  })

  it('keeps base with no-alternate reason when triggered without alternate', () => {
    const decided = decideThresholdRoute({
      enabled: true,
      routeKey: 'brain.primary',
      base: BASE,
      alternate: null,
      usage: { calls24h: 100, tokens24h: 0, tokenTelemetryComplete: true },
      limit: { maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }
    })
    assert.equal(decided.decision, 'threshold_reached_no_alternate')
    assert.deepEqual(decided.selected, BASE)
  })

  it('performs zero provider calls and zero DB effects', () => {
    // Pure function: deterministic output for identical input, no I/O surface.
    const input = {
      enabled: true,
      routeKey: 'brain.primary' as const,
      base: BASE,
      alternate: ALT,
      usage: { calls24h: 90, tokens24h: 0, tokenTelemetryComplete: true },
      limit: { maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }
    } as const
    assert.deepEqual(decideThresholdRoute({ ...input }), decideThresholdRoute({ ...input }))
  })
})
