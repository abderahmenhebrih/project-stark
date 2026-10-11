import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeProviderError, PROVIDER_GENERIC_MESSAGE } from './provider-error'

/**
 * Hackathon stabilization (AI error hardening): every main user-facing
 * failure maps to concise safe copy. No stack traces, endpoint dumps,
 * response bodies, or secrets — including auth, rate-limit, timeout,
 * unavailable, and structured-output failures.
 */
describe('provider error hardening', () => {
  it('auth failure maps to the rejected-key copy (never a 401 dump)', () => {
    const message = normalizeProviderError(
      new Error('Error invoking remote method stark:ai:generate 401 {"error":"invalid_api_key"}')
    ).message
    assert.equal(message, PROVIDER_GENERIC_MESSAGE)
    assert.ok(!message.includes('401'))
    assert.ok(!message.includes('invalid_api_key'))
  })

  it('known main failure copies survive transport wrapping', () => {
    const cases: Array<[string, string]> = [
      ['The AI provider is rate-limiting requests. Try again shortly.', 'rate-limit'],
      ['The AI provider request timed out. Try again.', 'timeout'],
      ['The AI provider could not be reached. Check your connection.', 'network'],
      ['The selected model is not available. Choose another model.', 'unavailable'],
      ['No AI model is selected yet.', 'model-missing'],
      ['No API key is saved for this provider yet.', 'missing key']
    ]
    for (const [copy, what] of cases) {
      const message = normalizeProviderError(new Error(`Error invoking remote method stark:ai:generate ${copy}`)).message
      assert.equal(message, copy, `${what} must keep its specific copy`)
    }
  })

  it('structured-output failure never leaks the model payload', () => {
    const message = normalizeProviderError(
      new Error(
        'Error invoking remote method stark:ai:propose The selected model could not create a structured code proposal. EXTRA {"targetId":"T1"}'
      )
    ).message
    // Either the specific proposal copy (via proposal-error) or the
    // generic provider fallback — never the transported payload.
    assert.ok(!message.includes('T1'))
    assert.ok(!message.includes('{'))
  })

  it('key material, urls, and bodies never reach the UI', () => {
    const hostile = new Error(
      'Error invoking remote method stark:providers:save-credential sk-live-abc123 https://api.openai.com/v1 Bearer xyz {"key":"sk-live-abc123"}'
    )
    const message = normalizeProviderError(hostile).message
    for (const leaked of ['sk-live-abc123', 'Bearer', 'api.openai.com', '{"key"']) {
      assert.ok(!message.includes(leaked), `must not leak ${leaked}`)
    }
    assert.equal(message, PROVIDER_GENERIC_MESSAGE)
  })
})
