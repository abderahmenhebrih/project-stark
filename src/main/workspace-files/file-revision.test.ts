import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { hashFileBytes, isValidRevision } from './file-revision'

const REVISION_PATTERN = /^[0-9a-f]{64}$/
const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('file revision', () => {
  it('produces identical revisions for identical bytes', () => {
    const bytes = Buffer.from('hello stark' + LF, 'utf8')
    assert.equal(hashFileBytes(bytes), sha256Hex(bytes))
    assert.equal(hashFileBytes(bytes), hashFileBytes(Buffer.from(bytes)))
  })

  it('changes the revision on a one-byte difference', () => {
    const a = hashFileBytes(Buffer.from('a', 'utf8'))
    const b = hashFileBytes(Buffer.from('b', 'utf8'))
    assert.notEqual(a, b)
  })

  it('hashes the empty file deterministically', () => {
    assert.equal(hashFileBytes(Buffer.alloc(0)), sha256Hex(Buffer.alloc(0)))
    assert.ok(REVISION_PATTERN.test(hashFileBytes(Buffer.alloc(0))))
  })

  it('distinguishes unicode content from ascii lookalikes', () => {
    const unicode = hashFileBytes(Buffer.from('héllo wörld ✓' + LF, 'utf8'))
    const ascii = hashFileBytes(Buffer.from('hello world' + LF, 'utf8'))
    assert.notEqual(unicode, ascii)
    assert.ok(REVISION_PATTERN.test(unicode))
  })

  it('treats LF and CRLF as different bytes', () => {
    const lf = hashFileBytes(Buffer.from('a' + LF + 'b', 'utf8'))
    const crlf = hashFileBytes(Buffer.from('a' + CRLF + 'b', 'utf8'))
    assert.notEqual(lf, crlf)
  })

  it('always returns exactly 64 lowercase hex chars', () => {
    for (const sample of ['', 'x', 'a longer sample with spaces 123', 'ünïcödé ✓']) {
      const revision = hashFileBytes(Buffer.from(sample, 'utf8'))
      assert.equal(revision.length, 64)
      assert.ok(REVISION_PATTERN.test(revision), `revision must be lowercase hex: ${revision}`)
      assert.equal(revision, revision.toLowerCase())
    }
  })

  it('validates renderer-supplied revisions strictly', () => {
    const valid = hashFileBytes(Buffer.from('ok', 'utf8'))
    assert.equal(isValidRevision(valid), true)
    assert.equal(isValidRevision(valid.toUpperCase()), false)
    assert.equal(isValidRevision(valid.slice(0, 63)), false)
    assert.equal(isValidRevision(`${valid}0`), false)
    assert.equal(isValidRevision('g'.repeat(64)), false)
    assert.equal(isValidRevision(''), false)
    assert.equal(isValidRevision(null), false)
    assert.equal(isValidRevision(42), false)
    assert.equal(isValidRevision(undefined), false)
  })
})
