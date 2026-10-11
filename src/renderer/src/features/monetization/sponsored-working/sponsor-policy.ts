/**
 * STARK sponsored-working plan/entitlement policy.
 *
 * Narrow monetization entitlement seam. Billing backend is future work:
 * this module maps the local account-plan value to the entitlement the
 * sponsor slot consumes. Monetization never depends on payment-provider
 * code directly.
 *
 * Current product semantics:
 * - Free (+ void-unfunded) → eligible, NOT ad-free.
 * - Magma / Frost / Void (funded) → ad-free, NOT eligible.
 * - adFree always overrides eligibility (defense in depth).
 */

import type { MonetizationEntitlement, StarkAccountPlan } from './sponsor-types'

export const FREE_PLAN: StarkAccountPlan = 'free'

/** Plans that are always ad-free (paid or funded). */
const AD_FREE_PLANS: ReadonlySet<string> = new Set(['magma', 'frost', 'void', 'void-funded'])

/**
 * Derives the monetization entitlement for one account plan.
 * Unknown / void-unfunded values fall back to Free semantics (eligible,
 * not ad-free) so a missing billing source can never lock Free inventory
 * nor grant ad-free without a funded plan.
 */
export function entitlementForPlan(plan: StarkAccountPlan | string): MonetizationEntitlement {
  const normalized = plan.trim().toLowerCase()
  if (AD_FREE_PLANS.has(normalized)) {
    return { sponsoredWorkingEligible: false, adFree: true }
  }
  return { sponsoredWorkingEligible: true, adFree: false }
}

/**
 * Defense-in-depth display gate: adFree always wins, even if a caller
 * passes an inconsistent entitlement object.
 */
export function isSponsorEligibleForEntitlement(entitlement: MonetizationEntitlement): boolean {
  if (entitlement.adFree) {
    return false
  }
  return entitlement.sponsoredWorkingEligible
}

/**
 * Resolves the entitlement when no real billing source exists yet.
 * Defaults to Free. The future billing integration replaces ONLY this
 * seam (plan → entitlement), never the sponsor slot itself.
 *
 * @param plan - local plan override for tests/embedders; defaults to 'free'.
 */
export function resolveMonetizationEntitlement(plan: StarkAccountPlan | string = 'free'): MonetizationEntitlement {
  return entitlementForPlan(plan)
}
