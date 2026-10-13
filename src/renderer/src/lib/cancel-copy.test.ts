import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeProviderError, PROVIDER_CANCELLED_MESSAGE } from './provider-error'
import { normalizeBrainError, BRAIN_CANCELLED_MESSAGE } from './brain-error'
import { normalizeProposalError, PROPOSAL_CANCELLED_MESSAGE } from './proposal-error'
import { normalizeChangeSetProposalError, CHANGE_SET_CANCELLED_MESSAGE } from './change-set-error'

/**
 * Cancellation copy proof: the exact main-process cancelled message
 * normalizes to a calm `cancelled` kind in every AI error boundary
 * (Ask/Work/Propose/Change Set) instead of collapsing to a generic
 * failure. Transport-wrapped copies still match by containment.
 */
const MAIN_CANCELLED = 'The AI operation was cancelled.'

describe('cancellation copy across AI boundaries', () => {
  it('maps the cancelled copy to the cancelled kind everywhere', () => {
    assert.equal(PROVIDER_CANCELLED_MESSAGE, MAIN_CANCELLED)
    assert.equal(BRAIN_CANCELLED_MESSAGE, MAIN_CANCELLED)
    assert.equal(PROPOSAL_CANCELLED_MESSAGE, MAIN_CANCELLED)
    assert.equal(CHANGE_SET_CANCELLED_MESSAGE, MAIN_CANCELLED)
    assert.deepEqual(normalizeProviderError(new Error(MAIN_CANCELLED)).kind, 'cancelled')
    assert.deepEqual(normalizeBrainError(new Error(MAIN_CANCELLED)).kind, 'cancelled')
    assert.deepEqual(normalizeProposalError(new Error(MAIN_CANCELLED)).kind, 'cancelled')
    assert.deepEqual(normalizeChangeSetProposalError(new Error(MAIN_CANCELLED)).kind, 'cancelled')
  })

  it('still recognizes transport-wrapped cancelled failures', () => {
    const wrapped = new Error(`Error invoking remote method 'stark:ai:run-brain': ${MAIN_CANCELLED}`)
    assert.equal(normalizeProviderError(wrapped).message, MAIN_CANCELLED)
    assert.equal(normalizeBrainError(wrapped).message, MAIN_CANCELLED)
  })

  it('never confuses timeout with cancellation', () => {
    const timeout = normalizeProviderError(new Error('The AI provider request timed out. Try again.'))
    assert.equal(timeout.kind, 'timeout')
    assert.notEqual(timeout.kind, 'cancelled')
  })
})
