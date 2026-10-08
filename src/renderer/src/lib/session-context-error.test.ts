import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeContextError } from './session-context-error'

describe('context error boundary', () => {
  it('maps each known context outcome', () => {
    const cases: [string, string][] = [
      ['This context item is too large to attach.', 'This context item is too large to attach.'],
      ['The total attached context is too large.', 'The total attached context is too large.'],
      ['You can attach at most 20 context items to one message.', 'You can attach at most 20 context items to one message.'],
      [
        'This file can’t be attached. Only text files can be used as context.',
        'This file can’t be attached. Only text files can be used as context.'
      ],
      ['This file is no longer available.', 'This file is no longer available.'],
      ['The selected line range is invalid.', 'The selected line range is invalid.'],
      [
        'This attached context changed on disk. Reattach it before sending.',
        'This attached context changed on disk. Reattach it before sending.'
      ],
      ['We couldn’t attach this context.', 'We couldn’t attach this context.']
    ]
    for (const [transported, expected] of cases) {
      assert.equal(normalizeContextError(new Error(`Error invoking remote method: ${transported}`)).message, expected)
    }
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeContextError(new Error('boom')).message, 'We couldn’t attach this context.')
    assert.equal(normalizeContextError(new Error('boom'), 'We couldn’t save this message.').message, 'We couldn’t save this message.')
    assert.equal(normalizeContextError(null).message, 'We couldn’t attach this context.')
  })

  it('never emits transport or internals wording', () => {
    const normalized = normalizeContextError(
      new Error('Error invoking remote method stark:session-context:prepare-file sqlite boom /abs/path')
    )
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('sqlite'))
    assert.ok(!normalized.message.includes('Error invoking'))
    assert.ok(!normalized.message.includes('/abs/path'))
  })
})
