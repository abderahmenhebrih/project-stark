import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeBrainError } from './brain-error'

describe('brain error boundary', () => {
  it('maps each known brain outcome', () => {
    const cases: [string, string][] = [
      ['There is no new message for STARK to answer.', 'There is no new message for STARK to answer.'],
      ['STARK could not form a valid work plan.', 'STARK could not form a valid work plan.'],
      ['STARK could not complete the delegated work.', 'STARK could not complete the delegated work.'],
      ['STARK could not complete the final response.', 'STARK could not complete the final response.'],
      [
        'A previous work run was interrupted. Start a new one explicitly.',
        'A previous work run was interrupted. Start a new one explicitly.'
      ],
      [
        'STARK is already generating a response for this session.',
        'STARK is already generating a response for this session.'
      ],
      ['We couldn’t start this work run.', 'We couldn’t start this work run.'],
      ['We couldn’t complete this work run.', 'We couldn’t complete this work run.']
    ]
    for (const [transported, expected] of cases) {
      assert.equal(normalizeBrainError(new Error(`Error invoking remote method: ${transported}`)).message, expected)
    }
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeBrainError(new Error('boom')).message, 'We couldn’t complete this work run.')
    assert.equal(normalizeBrainError(null).message, 'We couldn’t complete this work run.')
  })

  it('never emits transport or internals wording', () => {
    const normalized = normalizeBrainError(
      new Error('Error invoking remote method stark:ai:run-brain sqlite boom /abs/path {"action":1}')
    )
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('sqlite'))
    assert.ok(!normalized.message.includes('Error invoking'))
    assert.ok(!normalized.message.includes('/abs/path'))
  })
})
