import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeProviderError } from './provider-error'

describe('provider error boundary', () => {
  it('maps each known provider outcome', () => {
    const cases: [string, string][] = [
      ['Secure credential storage is not available on this system.', 'Secure credential storage is not available on this system.'],
      ['No API key is saved for this provider yet.', 'No API key is saved for this provider yet.'],
      ['The saved API key was rejected. Check the key and try again.', 'The saved API key was rejected. Check the key and try again.'],
      ['The AI provider is rate-limiting requests. Try again shortly.', 'The AI provider is rate-limiting requests. Try again shortly.'],
      ['The AI provider request timed out. Try again.', 'The AI provider request timed out. Try again.'],
      ['The AI provider could not be reached. Check your connection.', 'The AI provider could not be reached. Check your connection.'],
      ['The selected model is not available. Choose another model.', 'The selected model is not available. Choose another model.'],
      ['No AI model is selected yet.', 'No AI model is selected yet.'],
      ['A response is already being generated.', 'A response is already being generated.'],
      ['There is no new message for STARK to answer.', 'There is no new message for STARK to answer.'],
      ['We couldn’t get a response from the AI provider.', 'We couldn’t get a response from the AI provider.']
    ]
    for (const [transported, expected] of cases) {
      assert.equal(normalizeProviderError(new Error(`Error invoking remote method: ${transported}`)).message, expected)
    }
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeProviderError(new Error('boom')).message, 'We couldn’t get a response from the AI provider.')
    assert.equal(
      normalizeProviderError(new Error('boom'), 'We couldn’t load the AI provider settings.').message,
      'We couldn’t load the AI provider settings.'
    )
    assert.equal(normalizeProviderError(null).message, 'We couldn’t get a response from the AI provider.')
  })

  it('never emits secrets, bodies, or transport wording', () => {
    const normalized = normalizeProviderError(
      new Error('Error invoking remote method stark:providers:save-credential {"apiKey":"sk-secret"} 401 body')
    )
    assert.ok(!normalized.message.includes('sk-secret'))
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('Error invoking'))
  })
})
