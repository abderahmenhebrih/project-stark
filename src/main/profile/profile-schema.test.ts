import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseError } from '../database/errors'
import {
  CorruptProfileError,
  InvalidDisplayNameError,
  toPublicError
} from './errors'
import { DISPLAY_NAME_MAX_LENGTH, parseDisplayName, parseStoredProfile } from './profile-schema'

describe('profile schema', () => {
  it('trims and preserves internal spacing', () => {
    assert.equal(parseDisplayName('  Abdou GXD  '), 'Abdou GXD')
    assert.equal(parseDisplayName('Abdou   GXD'), 'Abdou   GXD')
  })

  it('counts length in Unicode code points', () => {
    assert.equal(DISPLAY_NAME_MAX_LENGTH, 40)
    assert.equal(parseDisplayName('x'.repeat(40)), 'x'.repeat(40))
    assert.throws(() => parseDisplayName('x'.repeat(41)), InvalidDisplayNameError)
  })

  it('rejects non-string payloads', () => {
    for (const bad of [null, undefined, 42, true, {}, ['Abdou']]) {
      assert.throws(() => parseDisplayName(bad), InvalidDisplayNameError)
    }
  })

  it('stored profiles require the exact shape', () => {
    assert.throws(() => parseStoredProfile(null), CorruptProfileError)
    assert.throws(() => parseStoredProfile('Abdou'), CorruptProfileError)
    assert.throws(() => parseStoredProfile({}), CorruptProfileError)
    assert.throws(() => parseStoredProfile({ displayName: 42 }), CorruptProfileError)
    assert.throws(() => parseStoredProfile({ displayName: '' }), CorruptProfileError)
    assert.deepEqual(parseStoredProfile({ displayName: 'Abdou', extra: 1 }), { displayName: 'Abdou' })
  })
})

describe('profile public errors', () => {
  it('invalid input maps to an actionable message without values', () => {
    const mapped = toPublicError('set-display-name', new InvalidDisplayNameError('display name must not be empty'))
    assert.ok(mapped.message.includes('stark profile set-display-name failed'))
    assert.ok(mapped.message.includes('display name must not be empty'))
  })

  it('corrupt storage maps without payload details', () => {
    const mapped = toPublicError('get', new CorruptProfileError())
    assert.equal(mapped.message, 'stark profile get failed: stored profile is invalid')
  })

  it('database failures map without internals', () => {
    const mapped = toPublicError('get', new DatabaseError('SQLITE_IOERR: disk I/O error'))
    assert.equal(mapped.message, 'stark profile get failed: storage unavailable')
    assert.ok(!mapped.message.includes('SQLITE'))
  })

  it('unknown failures map to a generic message', () => {
    const mapped = toPublicError('get', new Error('something strange'))
    assert.equal(mapped.message, 'stark profile get failed')
  })
})
