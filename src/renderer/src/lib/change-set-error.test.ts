import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeChangeSetProposalError } from './change-set-error'

describe('change-set proposal error boundary', () => {
  it('maps each known grouped-proposal outcome', () => {
    const cases: [string, string][] = [
      ['Attach two to five whole files to propose grouped code changes.', 'Attach two to five whole files to propose grouped code changes.'],
      ['There is no new message to propose changes for.', 'There is no new message to propose changes for.'],
      [
        'One of the attached files changed after you attached it. Attach the changed files again before requesting a proposal.',
        'One of the attached files changed after you attached it. Attach the changed files again before requesting a proposal.'
      ],
      [
        'One of the files changed while STARK was preparing the proposal. Attach it again and try again.',
        'One of the files changed while STARK was preparing the proposal. Attach it again and try again.'
      ],
      ['STARK did not propose any code changes.', 'STARK did not propose any code changes.'],
      ['STARK could not create a valid grouped code proposal.', 'STARK could not create a valid grouped code proposal.'],
      ['The grouped proposed changes are too large.', 'The grouped proposed changes are too large.'],
      [
        'The selected model could not create a structured code proposal. Choose another model.',
        'The selected model could not create a structured code proposal. Choose another model.'
      ],
      [
        'STARK is already generating a response for this session.',
        'STARK is already generating a response for this session.'
      ],
      ['We couldn’t prepare this grouped code proposal.', 'We couldn’t prepare this grouped code proposal.']
    ]
    for (const [transported, expected] of cases) {
      assert.equal(
        normalizeChangeSetProposalError(new Error(`Error invoking remote method: ${transported}`)).message,
        expected
      )
    }
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeChangeSetProposalError(new Error('boom')).message, 'We couldn’t prepare this grouped code proposal.')
    assert.equal(normalizeChangeSetProposalError(null).message, 'We couldn’t prepare this grouped code proposal.')
  })

  it('never emits transport or internals wording', () => {
    const normalized = normalizeChangeSetProposalError(
      new Error('Error invoking remote method stark:ai:propose-change-set sqlite boom /abs/path {"changes":[]}')
    )
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('sqlite'))
    assert.ok(!normalized.message.includes('Error invoking'))
    assert.ok(!normalized.message.includes('/abs/path'))
  })
})
