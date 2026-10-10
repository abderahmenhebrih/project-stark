import type { ReactElement } from 'react'
import { useApp } from '../../../app/app-context'
import { AccountSection } from '../../account/AccountSection'
import { ProfileSection } from '../../profile/ProfileSection'

/**
 * Settings → Account: absorbs the old Account + Profile pages.
 * Shows the real sign-in state and the local display-name preference
 * ("How should I call you?"). No OAuth additions, no fabricated
 * provider connections: when no account backend is active the
 * sections themselves say so honestly.
 */
export function AccountSettings(): ReactElement {
  const { profile, refreshProfile } = useApp()
  return (
    <section aria-label="Account">
      <p className="settings-section__title">Account</p>
      <p className="settings-section__copy">Manage your STARK identity and how STARK addresses you.</p>
      <div className="settings-section__block">
        <AccountSection />
      </div>
      <div className="settings-section__block">
        <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
      </div>
    </section>
  )
}
