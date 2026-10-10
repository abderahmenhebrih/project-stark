import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FORMAT_BUSY_MESSAGE,
  FORMAT_DISABLED_MESSAGE,
  FORMAT_GENERIC_MESSAGE,
  FORMAT_NOT_INSTALLED_MESSAGE,
  FORMAT_TIMEOUT_MESSAGE,
  FORMAT_UNSUPPORTED_MESSAGE,
  normalizeFormatterError
} from './format-error'

describe('formatter error boundary', () => {
  it('recognizes every stable main copy and collapses the rest', () => {
    assert.equal(normalizeFormatterError(new Error(`Error invoking remote method: ${FORMAT_NOT_INSTALLED_MESSAGE}`)).message, FORMAT_NOT_INSTALLED_MESSAGE)
    assert.equal(normalizeFormatterError(new Error(FORMAT_DISABLED_MESSAGE)).message, FORMAT_DISABLED_MESSAGE)
    assert.equal(normalizeFormatterError(new Error(FORMAT_UNSUPPORTED_MESSAGE)).message, FORMAT_UNSUPPORTED_MESSAGE)
    assert.equal(normalizeFormatterError(new Error(FORMAT_BUSY_MESSAGE)).message, FORMAT_BUSY_MESSAGE)
    assert.equal(normalizeFormatterError(new Error(FORMAT_TIMEOUT_MESSAGE)).message, FORMAT_TIMEOUT_MESSAGE)
    assert.equal(normalizeFormatterError(new Error('socket hang up')).message, FORMAT_GENERIC_MESSAGE)
    assert.equal(normalizeFormatterError(null).message, FORMAT_GENERIC_MESSAGE)
    assert.equal(normalizeFormatterError(new Error('')).message, FORMAT_GENERIC_MESSAGE)
  })
})
