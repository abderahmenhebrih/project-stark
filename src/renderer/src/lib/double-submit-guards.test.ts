import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  accountPanelReducer,
  initialAccountPanelState
} from '../features/account/account-state'
import {
  initialProfileEditorState,
  profileEditorReducer
} from '../features/profile/profile-state'

function rendererSource(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/')), 'utf8')
}

describe('privileged double-submit protection', () => {
  it('account actions ignore a second start while acting', () => {
    let state = initialAccountPanelState()
    state = accountPanelReducer(state, { type: 'action-started' })
    assert.equal(accountPanelReducer(state, { type: 'action-started' }), state)
  })

  it('profile saves ignore a second start while saving', () => {
    let state = initialProfileEditorState({ displayName: 'Abdou' })
    state = profileEditorReducer(state, { type: 'edit-started' })
    state = profileEditorReducer(state, { type: 'save-started' })
    assert.equal(profileEditorReducer(state, { type: 'save-started' }), state)
  })

  it('privileged buttons disable during their action', () => {
    // Scoped to exact disabled wirings (not random words): every
    // privileged submit path below must carry a disabled guard.
    const account = rendererSource('features/account/AccountSection.tsx')
    assert.ok(account.includes('disabled={state.acting}'), 'account buttons must disable while acting')
    const onboarding = rendererSource('features/onboarding/OnboardingPage.tsx')
    assert.ok(onboarding.includes('disabled={submitting}'), 'onboarding continue must disable while submitting')
    const profile = rendererSource('features/profile/ProfileSection.tsx')
    assert.ok(profile.includes('disabled={state.saving}'), 'profile save must disable while saving')
    const sessions = rendererSource('features/sessions/SessionPanel.tsx')
    for (const guard of ['disabled={', 'acting', 'saving', 'sending', 'preparing']) {
      assert.ok(sessions.includes(guard), `SessionPanel must carry ${guard} guards`)
    }
  })

  it('onboarding requires no account, provider key, or workspace', () => {
    const onboarding = rendererSource('features/onboarding/OnboardingPage.tsx')
    assert.ok(!onboarding.includes('getAccountApi'))
    assert.ok(!onboarding.includes('account-api'))
    assert.ok(!onboarding.includes('apiKey'))
    assert.ok(!onboarding.includes('workspace'))
    const boot = rendererSource('app/boot-state.ts')
    assert.ok(boot.includes("'onboarding'"), 'missing profile must route to onboarding')
  })
})
