import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_SESSION_TITLE_CODEPOINTS } from './limits'
import { deriveSessionTitle } from './session-title'

function codePoints(value: string): number {
  return [...value].length
}

describe('session title derivation', () => {
  it('keeps a normal sentence verbatim', () => {
    assert.equal(
      deriveSessionTitle('Fix the authentication middleware and check refresh tokens'),
      'Fix the authentication middleware and check refresh tokens'
    )
  })

  it('trims surrounding whitespace for derivation', () => {
    assert.equal(deriveSessionTitle('   hello world   '), 'hello world')
    assert.equal(deriveSessionTitle('\n\nhello\n\n'), 'hello')
  })

  it('collapses multiple spaces to one', () => {
    assert.equal(deriveSessionTitle('a   b    c'), 'a b c')
  })

  it('collapses newlines and tabs to single spaces', () => {
    assert.equal(deriveSessionTitle('line one\nline two\nline three'), 'line one line two line three')
    assert.equal(deriveSessionTitle('a\tb'), 'a b')
    assert.equal(deriveSessionTitle('a\r\nb'), 'a b')
  })

  it('handles a message beginning with blank lines', () => {
    assert.equal(deriveSessionTitle('\n\n\nreal content here'), 'real content here')
  })

  it('preserves Unicode and emoji', () => {
    assert.equal(deriveSessionTitle('caf\u00e9 \u65e5\u672c\u8a9e \u{1F389} party'), 'caf\u00e9 \u65e5\u672c\u8a9e \u{1F389} party')
  })

  it('keeps exactly 80 code points without ellipsis', () => {
    const eighty = `${'a'.repeat(79)}\u{1F389}`
    assert.equal(codePoints(eighty), 80)
    assert.equal(deriveSessionTitle(eighty), eighty)
  })

  it('bounds longer titles with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const title = deriveSessionTitle(long)
    assert.ok(title.endsWith('\u2026'))
    assert.ok(codePoints(title) <= MAX_SESSION_TITLE_CODEPOINTS + 1)
  })

  it('never emits an empty title for valid messages', () => {
    for (const content of ['hi', '  padded  ', 'a\nb', '\u00e9']) {
      const title = deriveSessionTitle(content)
      assert.ok(title.length > 0, JSON.stringify(content))
    }
  })
})
