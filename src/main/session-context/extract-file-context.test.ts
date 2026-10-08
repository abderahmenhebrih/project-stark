import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidContextRangeError } from './errors'
import { joinLines, sliceLines, splitLines, windowAroundLine } from './extract-file-context'

const SAMPLE = 'line one\nline two\r\nline three\rlast'

describe('file context extraction', () => {
  it('splits LF, CRLF, and lone CR', () => {
    assert.deepEqual(splitLines(SAMPLE), ['line one', 'line two', 'line three', 'last'])
    assert.deepEqual(splitLines(''), [''])
    assert.deepEqual(splitLines('single'), ['single'])
  })

  it('slices inclusive 1-based ranges', () => {
    assert.deepEqual(sliceLines('a\nb\nc\nd', 2, 3), ['b', 'c'])
    assert.deepEqual(sliceLines('a\nb', 1, 1), ['a'])
  })

  it('clamps an over-long end to the last line', () => {
    assert.deepEqual(sliceLines('a\nb', 2, 99), ['b'])
  })

  it('rejects reversed, zero, and past-end ranges', () => {
    assert.throws(() => sliceLines('a\nb', 2, 1), InvalidContextRangeError)
    assert.throws(() => sliceLines('a\nb', 0, 1), InvalidContextRangeError)
    assert.throws(() => sliceLines('a\nb', 3, 4), InvalidContextRangeError)
    assert.throws(() => sliceLines('a\nb', 1.5, 2), InvalidContextRangeError)
  })

  it('windows around an anchor with clamping', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `l${String(index + 1)}`).join('\n')
    const middle = windowAroundLine(lines, 5, 2)
    assert.deepEqual([middle.lineStart, middle.lineEnd], [3, 7])
    assert.equal(middle.lines.length, 5)
    const start = windowAroundLine(lines, 1, 3)
    assert.deepEqual([start.lineStart, start.lineEnd], [1, 4])
    const end = windowAroundLine(lines, 10, 3)
    assert.deepEqual([end.lineStart, end.lineEnd], [7, 10])
  })

  it('rejects out-of-file anchors', () => {
    assert.throws(() => windowAroundLine('a\nb', 0, 3), InvalidContextRangeError)
    assert.throws(() => windowAroundLine('a\nb', 3, 3), InvalidContextRangeError)
  })

  it('joins lines with LF', () => {
    assert.equal(joinLines(['a', 'b']), 'a\nb')
    assert.equal(joinLines([]), '')
  })
})
