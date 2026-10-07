import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toEditorFocus } from './editor-focus'

describe('editor focus mapping', () => {
  it('passes valid search result lines and columns through', () => {
    assert.deepEqual(toEditorFocus(12, 5), { lineNumber: 12, column: 5 })
    assert.deepEqual(toEditorFocus(1, 1), { lineNumber: 1, column: 1 })
  })

  it('falls back to column 1 when the column is unusable', () => {
    assert.deepEqual(toEditorFocus(3, 0), { lineNumber: 3, column: 1 })
    assert.deepEqual(toEditorFocus(3, -2), { lineNumber: 3, column: 1 })
    assert.deepEqual(toEditorFocus(3, 1.5), { lineNumber: 3, column: 1 })
    assert.deepEqual(toEditorFocus(3, '5'), { lineNumber: 3, column: 1 })
    assert.deepEqual(toEditorFocus(3, undefined), { lineNumber: 3, column: 1 })
  })

  it('rejects unusable lines with no focus request', () => {
    for (const line of [0, -1, 1.5, Number.NaN, '12', null, undefined]) {
      assert.equal(toEditorFocus(line, 1), null)
    }
  })
})
