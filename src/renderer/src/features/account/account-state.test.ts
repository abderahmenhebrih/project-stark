import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CloudAccountStatus } from '../../../../shared/cloud-account/types'
import { isCloudAccountStatus } from '../../../../shared/cloud-account/types'
import {
  accountInitials,
  accountPanelReducer,
  accountProviderLabel,
  initialAccountPanelState,
  isSafeAccountStatusPayload
} from './account-state'

describe('account renderer state', () => {
  it('starts idle with no status and no timers', () => {
    const state = initialAccountPanelState()
    assert.equal(state.loading, false)
    assert.equal(state.status, null)
    assert.equal(state.acting, false)
  })

  it('loads signed-out status and handles safe pushes', () => {
    let state = initialAccountPanelState()
    state = accountPanelReducer(state, { type: 'status-loading' })
    assert.equal(state.loading, true)
    state = accountPanelReducer(state, { type: 'status-loaded', status: { state: 'signed_out' } })
    assert.equal(state.status?.state, 'signed_out')
    state = accountPanelReducer(state, {
      type: 'pushed',
      status: { state: 'signed_in', account: { provider: 'google', email: 'a@b.c', displayName: 'A', avatarUrl: null } }
    })
    assert.equal(state.status?.state, 'signed_in')
  })

  it('signing-in and session_attention statuses reduce safely', () => {
    let state = initialAccountPanelState()
    const signingIn: CloudAccountStatus = { state: 'signing_in', provider: 'github' }
    assert.ok(isCloudAccountStatus(signingIn))
    state = accountPanelReducer(state, { type: 'status-loaded', status: signingIn })
    assert.equal(state.status?.state, 'signing_in')
    const attention: CloudAccountStatus = {
      state: 'session_attention',
      account: { provider: 'google', email: null, displayName: null, avatarUrl: null },
      reason: 'expired'
    }
    state = accountPanelReducer(state, { type: 'pushed', status: attention })
    assert.equal(state.status?.state, 'session_attention')
  })

  it('rejects token-bearing payloads', () => {
    assert.equal(isCloudAccountStatus({ state: 'signed_in', account: { provider: 'google', email: null, displayName: null, avatarUrl: null }, accessToken: 'x' }), false)
    assert.equal(isCloudAccountStatus({ state: 'signed_out', token: 'x' }), false)
    assert.equal(isCloudAccountStatus({ state: 'signed_out' }), true)
    assert.equal(isCloudAccountStatus({ state: 'unavailable' }), true)
    assert.equal(
      isSafeAccountStatusPayload({ state: 'signed_in', account: { provider: 'google' }, accessToken: 'ACCESS_SECRET_123' }),
      false
    )
    assert.equal(isSafeAccountStatusPayload({ state: 'signed_out' }), true)
  })

  it('labels providers and derives initials without remote images', () => {
    assert.equal(accountProviderLabel('google'), 'Google')
    assert.equal(accountProviderLabel('github'), 'GitHub')
    assert.equal(accountInitials('Abderahmen', null), 'AB')
    assert.equal(accountInitials(null, 'user@example.com'), 'US')
    assert.equal(accountInitials(null, null), 'S')
  })

  it('never exposes secrets in serialized state', () => {
    const state = accountPanelReducer(initialAccountPanelState(), {
      type: 'status-loaded',
      status: { state: 'signed_in', account: { provider: 'github', email: 'u@e.c', displayName: 'Abderahmen', avatarUrl: null } }
    })
    const serialized = JSON.stringify(state)
    for (const secret of ['ACCESS_SECRET_123', 'REFRESH_SECRET_456', 'CODE_SECRET_789', 'VERIFIER_SECRET_ABC']) {
      assert.ok(!serialized.includes(secret))
    }
  })
})
