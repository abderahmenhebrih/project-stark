import type { ReactElement } from 'react'
import { useAccountStatus } from '../../account/use-account-status'
import {
  FAIR_USE_FOOTNOTE,
  FREE_BILLING_MODELS,
  FREE_IMAGE_QUOTA,
  FREE_ATTACHMENT_QUOTA,
  FREE_MODEL_COUNT,
  FROST_BILLING_MODELS,
  FROST_PRICE_LABEL,
  HOSTED_USAGE_LIMITS_NOTE,
  MAGMA_BILLING_MODELS,
  MAGMA_PRICE_LABEL,
  VOID_MIN_RELOAD_LABEL,
  subscriptionModelCount
} from '../../billing/product-catalog'
import { productionEntitlements } from '../../billing/entitlements'
import { styleAssetUrls } from '../../styles/style-assets'
import './BillingSettings.css'

interface BillingSettingsProps {
  readonly onNavigateAccount: () => void
}

function logoFor(styleId: 'free' | 'magma' | 'frost' | 'void'): string {
  return styleAssetUrls(styleId).fullLogoUrl
}

/**
 * Settings → Billing: the four locked STARK offerings as product
 * information. No payment provider is integrated, so paid actions are
 * honest dead-ends: signed-out visitors route to Account, signed-in
 * accounts see a disabled "coming next" state. Nothing here changes
 * plans, fabricates credit, or issues invoices.
 */
export function BillingSettings({ onNavigateAccount }: BillingSettingsProps): ReactElement {
  const status = useAccountStatus()
  const signedIn = status !== null && (status.state === 'signed_in' || status.state === 'session_attention')
  const currentPlan = productionEntitlements().basePlan

  function upgradeAction(): ReactElement {
    if (!signedIn) {
      return (
        <button className="explorer__secondary" type="button" onClick={onNavigateAccount}>
          Sign in to upgrade
        </button>
      )
    }
    return (
      <button
        className="explorer__secondary"
        type="button"
        disabled
        title="Payment processing is not configured yet"
        aria-describedby="billing-checkout-note"
      >
        Checkout coming next
      </button>
    )
  }

  return (
    <section aria-label="Billing">
      <p className="settings-section__title">Billing</p>
      <p className="settings-section__copy">
        STARK plans and the Void wallet. {HOSTED_USAGE_LIMITS_NOTE}
      </p>
      <div className="billing-grid" aria-label="STARK plans">
        <article className="billing-card" aria-label="STARK Free">
          <img className="billing-card__logo" src={logoFor('free')} alt="" aria-hidden="true" draggable={false} />
          <p className="billing-card__name">STARK Free</p>
          <p className="billing-card__price">$0</p>
          <p className="billing-card__type">Free forever</p>
          <ul className="billing-card__facts">
            <li>{FREE_MODEL_COUNT} included models</li>
            <li>Brain max 5 · Heart max 5</li>
            <li>{FREE_ATTACHMENT_QUOTA}</li>
            <li>{FREE_IMAGE_QUOTA}</li>
            <li>No plugins</li>
            <li>Sponsored while STARK works</li>
            <li>STARK style</li>
          </ul>
          <details className="billing-card__models">
            <summary>Included models ({FREE_MODEL_COUNT})</summary>
            <ul>
              {FREE_BILLING_MODELS.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
          <div className="billing-card__action" aria-label="STARK Free action">
            {currentPlan === 'free' ? (
              <p className="billing-card__current" role="status">
                CURRENT
              </p>
            ) : null}
          </div>
        </article>
        <article className="billing-card billing-card--upgrade" aria-label="STARK Magma">
          <img className="billing-card__logo" src={logoFor('magma')} alt="" aria-hidden="true" draggable={false} />
          <p className="billing-card__name">STARK Magma</p>
          <p className="billing-card__price">{MAGMA_PRICE_LABEL}</p>
          <p className="billing-card__type">Subscription</p>
          <ul className="billing-card__facts">
            <li>{subscriptionModelCount('magma')} total models</li>
            <li>Brain max 10 · Heart max 10</li>
            <li>Unlimited attachments*</li>
            <li>Unlimited image generation*</li>
            <li>Plugins included</li>
            <li>Ad-free</li>
            <li>STARK + Magma styles while active</li>
          </ul>
          <details className="billing-card__models">
            <summary>Magma models (10)</summary>
            <ul>
              {MAGMA_BILLING_MODELS.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
          <div className="billing-card__action" aria-label="STARK Magma action">
            {upgradeAction()}
          </div>
        </article>
        <article className="billing-card billing-card--best" aria-label="STARK Frost, best value">
          <p className="billing-card__flag" aria-hidden="true">
            BEST VALUE
          </p>
          <img className="billing-card__logo" src={logoFor('frost')} alt="" aria-hidden="true" draggable={false} />
          <p className="billing-card__name">STARK Frost</p>
          <p className="billing-card__price">{FROST_PRICE_LABEL}</p>
          <p className="billing-card__type">Subscription</p>
          <ul className="billing-card__facts">
            <li>{subscriptionModelCount('frost')} total subscription models</li>
            <li>Brain max 15 · Heart max 15</li>
            <li>Unlimited attachments*</li>
            <li>Unlimited image generation*</li>
            <li>Plugins included</li>
            <li>Ad-free</li>
            <li>STARK + Magma + Frost styles while active</li>
          </ul>
          <details className="billing-card__models">
            <summary>Frost models (10)</summary>
            <ul>
              {FROST_BILLING_MODELS.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </details>
          <div className="billing-card__action" aria-label="STARK Frost action">
            {upgradeAction()}
          </div>
        </article>
        <article className="billing-card billing-card--wallet" aria-label="STARK Void, pay as you go">
          <p className="billing-card__flag billing-card__flag--wallet" aria-hidden="true">
            PAY AS YOU GO
          </p>
          <img className="billing-card__logo" src={logoFor('void')} alt="" aria-hidden="true" draggable={false} />
          <p className="billing-card__name">STARK Void</p>
          <p className="billing-card__price">{VOID_MIN_RELOAD_LABEL}</p>
          <p className="billing-card__type">Wallet, not a subscription</p>
          <ul className="billing-card__facts">
            <li>Major pay-as-you-go models</li>
            <li>Brain max 25 · Heart max 25 while funded</li>
            <li>Full paid benefits while funded</li>
            <li>Plugins while funded</li>
            <li>Ad-free while funded</li>
            <li>All four styles unlocked permanently on first reload</li>
          </ul>
          <div className="billing-card__action" aria-label="STARK Void action">
            {signedIn ? (
              <button
                className="explorer__secondary"
                type="button"
                disabled
                title="Void reloads are not configured yet"
                aria-describedby="billing-checkout-note"
              >
                Reloads coming next
              </button>
            ) : (
              <button className="explorer__secondary" type="button" onClick={onNavigateAccount}>
                Sign in to use Void
              </button>
            )}
          </div>
        </article>
      </div>
      <p className="session__hint" role="note" id="billing-checkout-note">
        {signedIn
          ? 'Checkout is not configured yet — payment processing comes next. No charge is made.'
          : 'Sign in with Google or GitHub to upgrade when checkout arrives.'}{' '}
        {FAIR_USE_FOOTNOTE}
      </p>
    </section>
  )
}
