import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidSessionMessageError, SessionMessageTooLargeError } from './errors'
import { MAX_MESSAGE_BYTES } from './limits'
import { validateUserMessageContent } from './message-validation'

describe('user message validation', () => {
  it('accepts a normal message unchanged', () => {
    assert.equal(validateUserMessageContent('Hello STARK'), 'Hello STARK')
  })

  it('preserves exact content without normalization', () => {
    const content = '  spaced  \n\tlines\r\n  end  '
    assert.equal(validateUserMessageContent(content), content)
  })

  it('accepts Unicode, newlines, carriage returns, and tabs', () => {
    const content = 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F389}\nline\r\n\ttab'
    assert.equal(validateUserMessageContent(content), content)
  })

  it('rejects empty and whitespace-only input', () => {
    for (const bad of ['', '   ', '\n\t \r\n']) {
      assert.throws(() => validateUserMessageContent(bad), InvalidSessionMessageError)
    }
  })

  it('rejects non-strings', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.throws(() => validateUserMessageContent(bad), InvalidSessionMessageError)
    }
  })

  it('rejects NUL bytes', () => {
    assert.throws(() => validateUserMessageContent('bad\0content'), InvalidSessionMessageError)
  })

  it('rejects unpaired surrogates', () => {
    assert.throws(() => validateUserMessageContent('lone \uD800 here'), InvalidSessionMessageError)
    assert.throws(() => validateUserMessageContent('lone \uDC00 here'), InvalidSessionMessageError)
    assert.equal(validateUserMessageContent('pair \uD83C\uDF89 ok'), 'pair \uD83C\uDF89 ok')
  })

  it('rejects other C0 controls and DEL but permits tab/newline/CR', () => {
    assert.throws(() => validateUserMessageContent('bell\x07'), InvalidSessionMessageError)
    assert.throws(() => validateUserMessageContent('esc\x1B'), InvalidSessionMessageError)
    assert.throws(() => validateUserMessageContent('del\x7F'), InvalidSessionMessageError)
    assert.equal(validateUserMessageContent('a\tb\nc\rd'), 'a\tb\nc\rd')
  })

  it('enforces the exact 64 KiB UTF-8 boundary', () => {
    const atLimit = 'a'.repeat(MAX_MESSAGE_BYTES)
    assert.equal(validateUserMessageContent(atLimit), atLimit)
    assert.throws(() => validateUserMessageContent(`${'a'.repeat(MAX_MESSAGE_BYTES)}b`), SessionMessageTooLargeError)
  })

  it('measures multi-byte characters in UTF-8 bytes, not code units', () => {
    // Each \u00e9 is 2 bytes in UTF-8: 32768 of them hit exactly 64 KiB.
    const atLimit = '\u00e9'.repeat(32768)
    assert.equal(validateUserMessageContent(atLimit), atLimit)
    assert.throws(() => validateUserMessageContent(`${atLimit}\u00e9`), SessionMessageTooLargeError)
  })
})
