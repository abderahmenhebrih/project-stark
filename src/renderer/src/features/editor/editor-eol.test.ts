import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyEol, isEditableEol } from './editor-eol'

const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const CRLF = CR + LF

describe('line-ending classification', () => {
  it('reports none for empty and single-line content', () => {
    assert.equal(classifyEol(''), 'none')
    assert.equal(classifyEol('one line, no breaks'), 'none')
    assert.equal(classifyEol('héllo ✓ unicode, no breaks'), 'none')
  })

  it('reports lf for uniform LF content', () => {
    assert.equal(classifyEol('a' + LF + 'b'), 'lf')
    assert.equal(classifyEol('a' + LF + 'b' + LF + 'c' + LF), 'lf')
    assert.equal(classifyEol('héllo ✓' + LF + 'wörld' + LF), 'lf')
  })

  it('reports crlf for uniform CRLF content', () => {
    assert.equal(classifyEol('a' + CRLF + 'b'), 'crlf')
    assert.equal(classifyEol('a' + CRLF + 'b' + CRLF + 'c' + CRLF), 'crlf')
    assert.equal(classifyEol('héllo ✓' + CRLF + 'wörld' + CRLF), 'crlf')
  })

  it('reports mixed for LF/CRLF mixtures', () => {
    assert.equal(classifyEol('a' + LF + 'b' + CRLF + 'c'), 'mixed')
    assert.equal(classifyEol('a' + CRLF + 'b' + LF + 'c'), 'mixed')
    assert.equal(classifyEol('a' + CRLF + 'b' + CRLF + 'c' + LF), 'mixed')
  })

  it('reports mixed for lone carriage returns', () => {
    assert.equal(classifyEol('a' + CR + 'b'), 'mixed')
    assert.equal(classifyEol('trailing' + CR), 'mixed')
    assert.equal(classifyEol(CR), 'mixed')
    assert.equal(classifyEol('a' + CR + LF + 'b' + CR + 'c'), 'mixed')
    assert.equal(classifyEol('classic mac' + CR + 'style' + CR), 'mixed')
  })

  it('gates editability on uniform endings only', () => {
    assert.equal(isEditableEol('none'), true)
    assert.equal(isEditableEol('lf'), true)
    assert.equal(isEditableEol('crlf'), true)
    assert.equal(isEditableEol('mixed'), false)
  })
})
