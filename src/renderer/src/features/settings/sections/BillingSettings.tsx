import type { ReactElement } from 'react'

/**
 * Settings → Billing: honest placeholder. No billing backend exists
 * yet — no plans, prices, checkout, invoices, or network calls.
 * Non-functional by design until accounts and plans are available.
 */
export function BillingSettings(): ReactElement {
  return (
    <section aria-label="Billing">
      <p className="settings-section__title">Billing</p>
      <p className="settings-section__copy">Manage your STARK plan, usage and billing.</p>
      <p className="session__hint" role="note">
        Billing controls will appear here when STARK accounts and plans are available.
      </p>
    </section>
  )
}
