import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isComposerEmpty, shouldSubmitComposerKey } from './composer-keys'
import { normalizeSessionError } from '../../lib/session-error'

describe('composer keyboard decisions', () => {
  it('Enter submits when the gate passes', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: false },
        { hasSession: true, isEmpty: false, sending: false, overLimit: false }
      ),
      true
    )
  })

  it('Shift+Enter never submits (newline)', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: true, isComposing: false },
        { hasSession: true, isEmpty: false, sending: false, overLimit: false }
      ),
      false
    )
  })

  it('IME-composing Enter never submits', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: true },
        { hasSession: true, isEmpty: false, sending: false, overLimit: false }
      ),
      false
    )
  })

  it('other keys never submit', () => {
    for (const key of ['a', ' ', 'Tab', 'Escape']) {
      assert.equal(
        shouldSubmitComposerKey(
          { key, shiftKey: false, isComposing: false },
          { hasSession: true, isEmpty: false, sending: false, overLimit: false }
        ),
        false
      )
    }
  })

  it('empty content never submits', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: false },
        { hasSession: true, isEmpty: true, sending: false, overLimit: false }
      ),
      false
    )
    assert.equal(isComposerEmpty('   \n\t '), true)
    assert.equal(isComposerEmpty(' x '), false)
  })

  it('an in-flight send never double-submits', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: false },
        { hasSession: true, isEmpty: false, sending: true, overLimit: false }
      ),
      false
    )
  })

  it('missing session or over-limit content never submits', () => {
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: false },
        { hasSession: false, isEmpty: false, sending: false, overLimit: false }
      ),
      false
    )
    assert.equal(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, isComposing: false },
        { hasSession: true, isEmpty: false, sending: false, overLimit: true }
      ),
      false
    )
  })
})

describe('session error boundary', () => {
  it('maps the too-large message', () => {
    assert.equal(normalizeSessionError(new Error('Error invoking remote method: This message is too large.')).message, 'This message is too large.')
  })

  it('maps save failures to safe copy', () => {
    assert.equal(
      normalizeSessionError(new Error('We couldn’t save this message.')).message,
      'We couldn’t save this message.'
    )
  })

  it('maps missing sessions and gone workspaces', () => {
    assert.equal(
      normalizeSessionError(new Error('That session is no longer available.')).message,
      'That session is no longer available.'
    )
    assert.equal(
      normalizeSessionError(new Error('That project folder is no longer available.')).message,
      'That project folder is no longer available.'
    )
  })

  it('collapses unknown failures to the caller fallback', () => {
    assert.equal(normalizeSessionError(new Error('boom')).message, 'We couldn’t save this message.')
    assert.equal(normalizeSessionError(new Error('boom'), 'We couldn’t load your sessions.').message, 'We couldn’t load your sessions.')
    assert.equal(normalizeSessionError(null).message, 'We couldn’t save this message.')
    assert.equal(normalizeSessionError('string').message, 'We couldn’t save this message.')
  })

  it('never emits transport or internals wording', () => {
    const normalized = normalizeSessionError(new Error('Error invoking remote method stark:sessions:create sqlite boom'))
    assert.ok(!normalized.message.includes('stark:'))
    assert.ok(!normalized.message.includes('sqlite'))
    assert.ok(!normalized.message.includes('Error invoking'))
  })
})
