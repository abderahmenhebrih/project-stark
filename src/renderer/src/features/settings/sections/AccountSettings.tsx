import type { ReactElement } from 'react'
import { useApp } from '../../../app/app-context'
import { AccountSection } from '../../account/AccountSection'
import { accountInitials } from '../../account/account-state'
import { ProfileSection } from '../../profile/ProfileSection'
import './AccountSettings.css'

interface AccountSettingsProps {
  /** Safe Settings-internal route to Billing (plan summary link). */
  readonly onNavigateBilling?: () => void
}

/**
 * Settings → Account: two-card layout over the full content canvas.
 *
 * LEFT: the STARK Account authentication card (Google/GitHub OAuth,
 * plan, sign out — owned by AccountSection, behavior unchanged).
 * RIGHT: the Local Profile card (how STARK addresses you locally,
 * independent from OAuth identity) with the current plan summary.
 * No auth logic lives here; this file is layout only.
 */
export function AccountSettings({ onNavigateBilling }: AccountSettingsProps): ReactElement {
  const { profile, refreshProfile } = useApp()
  const displayName = profile?.displayName ?? ''
  return (
    <section aria-label="Account" className="account-page">
      <p className="settings-section__title">Account</p>
      <p className="settings-section__copy">Manage your STARK identity and how STARK addresses you.</p>
      <div className="account-grid">
        <div className="account-card">
          <AccountSection />
        </div>
        <div className="account-card">
          <h2>Local Profile</h2>
          <div className="profile-identity">
            <span className="profile-avatar" aria-hidden="true">
              {accountInitials(displayName, null)}
            </span>
            <p className="profile-name">{displayName === '' ? '…' : displayName}</p>
          </div>
          <ProfileSection current={profile} onChanged={() => void refreshProfile()} />
          <div className="plan-row">
            <span className="plan-row__label">Current plan</span>
            <span className="plan-row__value">STARK Free</span>
          </div>
          {onNavigateBilling === undefined ? null : (
            <button className="explorer__secondary" type="button" onClick={onNavigateBilling}>
              View Billing
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
