import type { ReactElement } from 'react'
import { AccountSection } from '../../account/AccountSection'
import './AccountSettings.css'

interface AccountSettingsProps {
  /** Safe Settings-internal route to Billing (plan summary link). */
  readonly onNavigateBilling?: () => void
}

/**
 * Settings → Account: one clean account surface over the wide canvas.
 *
 * The STARK Account authentication card (Google/GitHub OAuth, plan,
 * sign out — owned by AccountSection, behavior unchanged) plus a
 * safe View Billing route. One identity only, no duplicate plan
 * display. The local nickname preference ("STARK calls you")
 * stays alive in the welcome surface + ProfileSection — it is simply
 * not exposed as a second identity here. No auth logic lives here;
 * this file is layout only.
 */
export function AccountSettings({ onNavigateBilling }: AccountSettingsProps): ReactElement {
  return (
    <section aria-label="Account" className="account-page">
      <p className="settings-section__title">Account</p>
      <p className="settings-section__copy">Manage your STARK account.</p>
      <div className="account-single">
        <div className="account-card account-card--single">
          <AccountSection />
          {onNavigateBilling === undefined ? null : (
            <div className="account-actions">
              <button className="explorer__secondary" type="button" onClick={onNavigateBilling}>
                View Billing
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
