import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canSendWithProvider, providerReadiness, providerReadinessLabel } from './provider-readiness'

describe('canonical provider readiness', () => {
  it('distinguishes not-configured, needs-model, and ready', () => {
    assert.equal(providerReadiness(false, null), 'not-configured')
    assert.equal(providerReadiness(false, 'gpt-4o'), 'not-configured')
    assert.equal(providerReadiness(true, null), 'needs-model')
    assert.equal(providerReadiness(true, 'gpt-4o'), 'ready')
  })

  it('gates sending on readiness: BYOK ready and signed-in Free send', () => {
    assert.equal(canSendWithProvider('not-configured'), false)
    // The old contradiction: configured=true with no model looked
    // "configured" to Usage while the banner said "not connected".
    // Through this selector it is one value — needs-model — and it
    // cannot send.
    assert.equal(canSendWithProvider('needs-model'), false)
    assert.equal(canSendWithProvider('ready'), true)
    // Signed-in Free sends through hosted inference; signed-out
    // sessions stay gated behind the sign-in prompt.
    assert.equal(canSendWithProvider('free'), true)
  })

  it('labels every state honestly', () => {
    assert.equal(providerReadinessLabel('not-configured'), 'Not configured')
    assert.equal(providerReadinessLabel('needs-model'), 'Configured — no model selected')
    assert.equal(providerReadinessLabel('ready'), 'Ready')
    assert.equal(providerReadinessLabel('free'), 'STARK Free')
  })
})
