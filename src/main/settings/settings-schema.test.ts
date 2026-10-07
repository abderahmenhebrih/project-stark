import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseError } from '../database/errors'
import {
  CorruptSettingsError,
  InvalidSettingsError,
  toPublicError
} from './errors'
import { parseStoredSettings, parseUpdatePatch } from './settings-schema'

describe('settings schema', () => {
  it('empty patch is a valid no-op update', () => {
    assert.deepEqual(parseUpdatePatch({}), {})
  })

  it('error messages never echo offending values', () => {
    try {
      parseUpdatePatch({ appearance: 'blue' })
      assert.fail('expected InvalidSettingsError')
    } catch (error) {
      assert.ok(error instanceof InvalidSettingsError)
      assert.ok(!error.message.includes('blue'))
    }
    try {
      parseUpdatePatch({ sneakyField: 'sneaky-value' })
      assert.fail('expected InvalidSettingsError')
    } catch (error) {
      assert.ok(error instanceof InvalidSettingsError)
    }
  })

  it('non-object stored settings are corrupt', () => {
    assert.throws(() => parseStoredSettings(null), CorruptSettingsError)
    assert.throws(() => parseStoredSettings('dark'), CorruptSettingsError)
    assert.throws(() => parseStoredSettings([1]), CorruptSettingsError)
  })
})

describe('settings public errors', () => {
  it('invalid input maps to an actionable message', () => {
    const mapped = toPublicError('update', new InvalidSettingsError('appearance must be x'))
    assert.ok(mapped.message.includes('settings update failed'))
    assert.ok(mapped.message.includes('appearance must be x'))
  })

  it('corrupt storage maps without payload details', () => {
    const mapped = toPublicError('get', new CorruptSettingsError())
    assert.equal(mapped.message, 'stark settings get failed: stored settings are invalid')
  })

  it('database failures map without internals', () => {
    const mapped = toPublicError('reset', new DatabaseError('SQLITE_IOERR: disk I/O error'))
    assert.equal(mapped.message, 'stark settings reset failed: storage unavailable')
    assert.ok(!mapped.message.includes('SQLITE'))
  })

  it('unknown failures map to a generic message', () => {
    const mapped = toPublicError('get', new Error('something strange'))
    assert.equal(mapped.message, 'stark settings get failed')
  })
})
