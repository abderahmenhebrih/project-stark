import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeProposalError } from './proposal-error'

describe('proposal error boundary', () => {
  it('maps each known proposal outcome', () => {
    const cases: [string, string][] = [
      ['Attach exactly one whole file to propose a code change.', 'Attach exactly one whole file to propose a code change.'],
      ['There is no new message to propose a change for.', 'There is no new message to propose a change for.'],
      [
        'This file changed after you attached it. Attach it again before requesting a change.',
        'This file changed after you attached it. Attach it again before requesting a change.'
      ],
      [
        'The file changed while STARK was preparing the proposal. Attach it again and try again.',
        'The file changed while STARK was preparing the proposal. Attach it again and try again.'
      ],
      ['STARK did not propose any code changes.', 'STARK did not propose any code changes.'],
      ['STARK could not create a valid code proposal.', 'STARK could not create a valid code proposal.'],
      ['The proposed change is too large.', 'The proposed change is too large.'],
      [
        'The selected model could not create a structured code proposal. Choose another model.',
        'The selected model could not create a structured code proposal. Choose another model.'
      ],
      [
        'STARK is already generating a response for this session.',
        'STARK is already generating a response for this session.'
      ],
      ['We couldn’t prepare this code proposal.', 'We couldn’t prepare this code proposal.']
    ]
    for (const [transported, expected] of cases) {
      assert.equal(normalizeProposalError(new Error(`Error invoking remote method: ${transported}`)).message, expected)
    }
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeProposalError(new Error('boom')).message, 'We couldn’t prepare this code proposal.')
    assert.equal(normalizeProposalError(null).message, 'We couldn’t prepare this code proposal.')
  })

  it('never emits transport or internals wording', () => {
    const normalized = normalizeProposalError(
      new Error('Error invoking remote method stark:ai:propose-file-change sqlite boom /abs/path {"summary":1}')
    )
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('sqlite'))
    assert.ok(!normalized.message.includes('Error invoking'))
    assert.ok(!normalized.message.includes('/abs/path'))
  })
})
