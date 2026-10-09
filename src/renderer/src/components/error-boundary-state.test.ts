import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DISPLAY_ERROR_MESSAGE,
  DISPLAY_ERROR_RELOAD_LABEL,
  errorBoundaryStateFor,
  initialErrorBoundaryState
} from './error-boundary-state'

describe('renderer Error Boundary contract', () => {
  it('uses fixed safe copy with a side-effect-free reload action', () => {
    assert.equal(DISPLAY_ERROR_MESSAGE, 'STARK encountered a display error.')
    assert.equal(DISPLAY_ERROR_RELOAD_LABEL, 'Reload interface')
    assert.deepEqual(initialErrorBoundaryState(), { hasError: false })
    assert.deepEqual(errorBoundaryStateFor(new Error('secret stack with sk-xyz')), { hasError: true })
    // The derived state carries no error content: no stack, no secret.
    assert.ok(!JSON.stringify(errorBoundaryStateFor(new Error('boom'))).includes('boom'))
  })
})
