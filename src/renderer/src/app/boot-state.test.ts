import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveBootState } from './boot-state'

describe('boot state', () => {
  it('loading dominates while the profile request is in flight', () => {
    assert.equal(resolveBootState({ loading: true, profile: null, loadError: false }), 'loading')
    assert.equal(
      resolveBootState({ loading: true, profile: { displayName: 'Abdou' }, loadError: false }),
      'loading'
    )
  })

  it('null profile resolves to onboarding', () => {
    assert.equal(resolveBootState({ loading: false, profile: null, loadError: false }), 'onboarding')
  })

  it('valid profile resolves to ready', () => {
    assert.equal(
      resolveBootState({ loading: false, profile: { displayName: 'Abdou' }, loadError: false }),
      'ready'
    )
  })

  it('load failure resolves to error', () => {
    assert.equal(resolveBootState({ loading: false, profile: null, loadError: true }), 'error')
  })
})
