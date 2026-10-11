/**
 * STARK central entitlement model.
 *
 * ONE product-state derivation consumed by Billing, Styles, LoopLink
 * limits, Plugins, attachments/images, and sponsored-working. Feature
 * code consumes derived AccountEntitlements — never scatters
 * `plan === 'magma'` checks.
 *
 * PRODUCTION TRUTH (no billing backend yet): every account resolves
 * to the Free base plan with an empty, never-activated Void wallet.
 * Signing in does NOT imply a paid plan. Tests and explicit
 * development fixtures may inject synthetic states; production UI
 * offers no plan spoofing.
 */

import type { CloudAccountStatus } from '../../../../shared/cloud-account/types'
import type { BrandStyleId } from '../../../../shared/settings/types'
import type { MonetizationEntitlement } from '../monetization/sponsored-working/sponsor-types'
import {
  FREE_CHAIN_MAX,
  FROST_CHAIN_MAX,
  FUNDED_VOID_CHAIN_MAX,
  MAGMA_CHAIN_MAX,
  type AccountProductState,
  type BasePlan,
  type VoidWalletState
} from './product-catalog'

export type { AccountProductState, BasePlan, VoidWalletState }

/** Attachment policy: exact Free quota or unlimited fair-use. */
export type AttachmentPolicy =
  | { readonly kind: 'limited'; readonly label: '5 attachments / 12 hours' }
  | { readonly kind: 'unlimited' }

/** Image-generation policy: exact Free quota or unlimited fair-use. */
export type ImageGenerationPolicy =
  | { readonly kind: 'limited'; readonly label: '10 image generations / day' }
  | { readonly kind: 'unlimited' }

/**
 * Derived product entitlements. Every field is computed by
 * deriveAccountEntitlements — components read, never construct.
 */
export interface AccountEntitlements {
  readonly basePlan: BasePlan
  /** Void wallet funds real benefits only while balanceMicros > 0. */
  readonly voidFunded: boolean
  readonly voidActivatedEver: boolean
  readonly includedModelCount: number
  readonly maxBrainModels: number
  readonly maxHeartModels: number
  readonly sponsoredWorkingEligible: boolean
  readonly adFree: boolean
  readonly pluginsEnabled: boolean
  readonly attachmentPolicy: AttachmentPolicy
  readonly imageGenerationPolicy: ImageGenerationPolicy
  /** Styles currently unlocked (subscription-gated + permanent Void unlocks). */
  readonly unlockedStyles: readonly BrandStyleId[]
}

function chainMaxForPlan(plan: BasePlan): number {
  switch (plan) {
    case 'free':
      return FREE_CHAIN_MAX
    case 'magma':
      return MAGMA_CHAIN_MAX
    case 'frost':
      return FROST_CHAIN_MAX
  }
}

function subscriptionStylesFor(plan: BasePlan): readonly BrandStyleId[] {
  switch (plan) {
    case 'free':
      return ['free']
    case 'magma':
      return ['free', 'magma']
    case 'frost':
      return ['free', 'magma', 'frost']
  }
}

/**
 * Derives entitlements from product state. Functional Void benefits
 * (chains, plugins, ads, quotas) apply only while funded; the
 * activatedEver style unlock is permanent even at zero balance.
 * A funded Void can only raise limits, never lower the base plan —
 * so Frost + empty wallet stays ad-free with Frost limits.
 */
export function deriveAccountEntitlements(product: AccountProductState): AccountEntitlements {
  const voidFunded = product.voidWallet.balanceMicros > 0
  const chainMax = Math.max(chainMaxForPlan(product.basePlan), voidFunded ? FUNDED_VOID_CHAIN_MAX : 0)
  const paidBenefits = product.basePlan !== 'free' || voidFunded
  const unlocked = new Set<BrandStyleId>(subscriptionStylesFor(product.basePlan))
  if (product.voidWallet.activatedEver) {
    unlocked.add('free')
    unlocked.add('magma')
    unlocked.add('frost')
    unlocked.add('void')
  }
  return {
    basePlan: product.basePlan,
    voidFunded,
    voidActivatedEver: product.voidWallet.activatedEver,
    includedModelCount: product.basePlan === 'free' ? 15 : product.basePlan === 'magma' ? 25 : 35,
    maxBrainModels: chainMax,
    maxHeartModels: chainMax,
    sponsoredWorkingEligible: !paidBenefits,
    adFree: paidBenefits,
    pluginsEnabled: paidBenefits,
    attachmentPolicy: paidBenefits ? { kind: 'unlimited' } : { kind: 'limited', label: '5 attachments / 12 hours' },
    imageGenerationPolicy: paidBenefits ? { kind: 'unlimited' } : { kind: 'limited', label: '10 image generations / day' },
    unlockedStyles: [...unlocked]
  }
}

/** Production product state until a real billing backend exists. */
export function defaultProductState(): AccountProductState {
  return { basePlan: 'free', voidWallet: { activatedEver: false, balanceMicros: 0 } }
}

/** Production entitlements: Free base, empty Void wallet. */
export function productionEntitlements(): AccountEntitlements {
  return deriveAccountEntitlements(defaultProductState())
}

/**
 * Resolves product state for an account status. Auth and Billing are
 * separate: signed-in with no billing backend is still Free. The
 * future billing backend will return basePlan + Void wallet here.
 */
export function resolveProductStateForAccount(_status: CloudAccountStatus | null): AccountProductState {
  void _status
  return defaultProductState()
}

/** Central sponsor mapping (replaces direct plan resolution). */
export function toSponsorEntitlement(entitlements: AccountEntitlements): MonetizationEntitlement {
  if (entitlements.adFree) {
    return { sponsoredWorkingEligible: false, adFree: true }
  }
  return {
    sponsoredWorkingEligible: entitlements.sponsoredWorkingEligible,
    adFree: false
  }
}

/**
 * Explicit development/test fixtures. Never wired to production UI —
 * production cannot self-upgrade without payment.
 */
export function devFixtureProductState(
  kind: 'magma' | 'frost' | 'void-funded' | 'void-activated-empty' | 'free'
): AccountProductState {
  switch (kind) {
    case 'magma':
      return { basePlan: 'magma', voidWallet: { activatedEver: false, balanceMicros: 0 } }
    case 'frost':
      return { basePlan: 'frost', voidWallet: { activatedEver: false, balanceMicros: 0 } }
    case 'void-funded':
      return { basePlan: 'free', voidWallet: { activatedEver: true, balanceMicros: 5000000 } }
    case 'void-activated-empty':
      return { basePlan: 'free', voidWallet: { activatedEver: true, balanceMicros: 0 } }
    case 'free':
      return defaultProductState()
  }
}
