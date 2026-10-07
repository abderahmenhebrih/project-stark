import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidSearchQueryError } from './errors'
import { InvalidWorkspaceError } from '../workspace/errors'
import {
  buildPreview,
  countCodePoints,
  findLiteralOccurrences,
  hasControlCharacters,
  isSensitiveFileName,
  parseSearchRequest,
  toDisplayColumn,
  validateSearchQuery
} from './search-file'
import { MAX_PREVIEW_CHARACTERS } from './limits'

describe('search query validation', () => {
  it('accepts a normal query', () => {
    assert.equal(validateSearchQuery('authentication'), 'authentication')
  })

  it('accepts a 1-character query', () => {
    assert.equal(validateSearchQuery('a'), 'a')
  })

  it('accepts a unicode query', () => {
    assert.equal(validateSearchQuery('héllo ✓'), 'héllo ✓')
  })

  it('accepts a 256-code-point query', () => {
    const query = 'a'.repeat(256)
    assert.equal(countCodePoints(query), 256)
    assert.equal(validateSearchQuery(query), query)
  })

  it('accepts 256 emoji code points while rejecting 257', () => {
    const ok = '✓'.repeat(256)
    assert.equal(validateSearchQuery(ok), ok)
    assert.throws(() => validateSearchQuery('✓'.repeat(257)), InvalidSearchQueryError)
  })

  it('rejects a 257-code-point query', () => {
    assert.throws(() => validateSearchQuery('a'.repeat(257)), InvalidSearchQueryError)
  })

  it('rejects empty and whitespace-only queries', () => {
    assert.throws(() => validateSearchQuery(''), InvalidSearchQueryError)
    assert.throws(() => validateSearchQuery('   '), InvalidSearchQueryError)
    const tabOnly = String.fromCharCode(9, 9)
    assert.throws(() => validateSearchQuery(tabOnly), InvalidSearchQueryError)
  })

  it('rejects control characters including newline and tab', () => {
    assert.ok(hasControlCharacters(String.fromCharCode(10)))
    assert.ok(hasControlCharacters(String.fromCharCode(13)))
    assert.ok(hasControlCharacters(String.fromCharCode(9)))
    assert.ok(hasControlCharacters(String.fromCharCode(0)))
    assert.ok(hasControlCharacters(String.fromCharCode(127)))
    assert.ok(!hasControlCharacters('authentication 123'))
    assert.throws(() => validateSearchQuery('auth' + String.fromCharCode(10) + 'x'), InvalidSearchQueryError)
    assert.throws(() => validateSearchQuery('auth' + String.fromCharCode(0) + 'x'), InvalidSearchQueryError)
  })

  it('rejects non-string queries', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.throws(() => validateSearchQuery(bad), InvalidSearchQueryError)
    }
  })

  it('treats regex-looking characters literally', () => {
    assert.deepEqual(findLiteralOccurrences('abc', '.*', false), [])
    assert.deepEqual(findLiteralOccurrences('a.*b', '.*', false), [1])
    assert.deepEqual(findLiteralOccurrences('a[b (c) \\ d', '[b (c) \\', false), [1])
  })

  it('rejects invalid caseSensitive flags', () => {
    assert.throws(() => parseSearchRequest({ workspaceId: 1, query: 'ok', caseSensitive: 'true' }), InvalidSearchQueryError)
    assert.throws(() => parseSearchRequest({ workspaceId: 1, query: 'ok', caseSensitive: 1 }), InvalidSearchQueryError)
    assert.throws(() => parseSearchRequest({ workspaceId: 1, query: 'ok', caseSensitive: null }), InvalidSearchQueryError)
  })

  it('defaults caseSensitive to false', () => {
    assert.deepEqual(parseSearchRequest({ workspaceId: 1, query: 'ok' }), {
      workspaceId: 1,
      query: 'ok',
      caseSensitive: false
    })
  })

  it('rejects invalid workspace ids and unknown fields', () => {
    for (const badId of ['1', 0, -2, 1.5, Number.NaN, null]) {
      assert.throws(() => parseSearchRequest({ workspaceId: badId, query: 'ok' }), InvalidWorkspaceError)
    }
    assert.throws(
      () => parseSearchRequest({ workspaceId: 1, query: 'ok', rootPath: '/tmp' }),
      InvalidSearchQueryError
    )
    assert.throws(() => parseSearchRequest({ workspaceId: 1, query: 'ok', extra: true }), InvalidSearchQueryError)
    assert.throws(() => parseSearchRequest(null), InvalidSearchQueryError)
  })
})

describe('sensitive-file policy', () => {
  it('excludes secret-bearing names', () => {
    for (const name of ['.env', '.ENV', '.env.local', '.env.production', 'id.pem', 'key.KEY', 'cert.p12', 'store.pfx', 'credentials.json', 'CREDENTIALS.YML', 'credentials.yaml']) {
      assert.ok(isSensitiveFileName(name), `${name} must be sensitive`)
    }
  })

  it('keeps normal dotfiles searchable', () => {
    for (const name of ['.gitignore', 'mycredentials.json.bak', 'package.json', 'readme.md', 'app.env']) {
      assert.ok(!isSensitiveFileName(name), `${name} must not be sensitive`)
    }
    assert.ok(isSensitiveFileName('.env.example'))
  })
})

describe('preview and columns', () => {
  it('returns short lines verbatim', () => {
    assert.equal(buildPreview('hello', 1), 'hello')
  })

  it('caps previews at 240 code points with the match visible', () => {
    const line = 'x'.repeat(500)
    const preview = buildPreview(line, 400)
    assert.equal(Array.from(preview).length, MAX_PREVIEW_CHARACTERS)
    assert.ok(preview.includes('x'))
    const early = buildPreview(line, 1)
    assert.equal(Array.from(early).length, MAX_PREVIEW_CHARACTERS)
  })

  it('computes 1-based columns', () => {
    assert.equal(toDisplayColumn('xx authentication', 3), 4)
    assert.equal(toDisplayColumn('abc', 0), 1)
  })

  it('finds multiple literal matches on one line in order', () => {
    assert.deepEqual(findLiteralOccurrences('auth auth auth', 'auth', true), [0, 5, 10])
  })
})
