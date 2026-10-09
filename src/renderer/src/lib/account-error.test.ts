import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACCOUNT_GENERIC_MESSAGE,
  ACCOUNT_SECURE_STORAGE_MESSAGE,
  normalizeAccountError
} from './account-error'

describe('account error boundary', () => {
  it('maps stable categories to display-safe copy', () => {
    assert.equal(normalizeAccountError(new Error('cloud-auth-unavailable')).message, 'Cloud account features are unavailable in this build.')
    assert.equal(normalizeAccountError(new Error('cloud-auth-in-progress')).message, 'An account sign-in is already in progress.')
    assert.equal(normalizeAccountError(new Error('cloud-auth-secure-storage-unavailable')).message, ACCOUNT_SECURE_STORAGE_MESSAGE)
  })

  it('collapses unknown failures and transport wording to the fallback', () => {
    assert.equal(normalizeAccountError(new Error('boom'), 'fallback').message, 'fallback')
    assert.equal(normalizeAccountError(new Error('Error invoking remote method'), ACCOUNT_GENERIC_MESSAGE).message, ACCOUNT_GENERIC_MESSAGE)
  })

  it('never surfaces tokens, codes, or URLs', () => {
    const normalized = normalizeAccountError(new Error('cloud-auth-exchange-failed ACCESS_SECRET_123')).message
    assert.ok(!normalized.includes('ACCESS_SECRET_123'))
    assert.ok(!JSON.stringify(normalized).includes('CODE_SECRET_789'))
  })
})
