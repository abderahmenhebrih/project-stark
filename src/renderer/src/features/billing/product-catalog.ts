/**
 * STARK product catalog (Billing foundation).
 *
 * ONE typed catalog for the four locked offerings: Free / Magma /
 * Frost base plans plus the Void PAYG wallet. Billing UI, Styles,
 * LoopLink limits, Plugins, attachments, and sponsored-working all
 * derive from this catalog through entitlements.ts — never from
 * scattered plan-string checks.
 *
 * PRODUCT-LOCKED:
 * - BasePlan is 'free' | 'magma' | 'frost'. Void is NOT a base plan;
 *   it is a separate wallet capability (see VoidWalletState).
 * - Paid model names below are BILLING INFORMATION ONLY. Settings →
 *   Models stays the locked 15-model Free catalog until the later
 *   model-runtime/catalog pass.
 * - No payment provider is integrated. BillingService captures the
 *   future narrow interface; production is unavailable by design.
 */

/** Subscription base plans. Void is never a member of this union. */
export type BasePlan = 'free' | 'magma' | 'frost'

/**
 * Void PAYG wallet. Functional benefits apply only while funded
 * (balanceMicros > 0); style unlocks from activatedEver are permanent.
 */
export interface VoidWalletState {
  readonly activatedEver: boolean
  readonly balanceMicros: number
}

/** Account product state: base plan plus the separate Void wallet. */
export interface AccountProductState {
  readonly basePlan: BasePlan
  readonly voidWallet: VoidWalletState
}

/** Locked prices (USD). Monthly for subscriptions, minimum reload for Void. */
export const FREE_PRICE_USD = 0
export const MAGMA_PRICE_USD = 10
export const FROST_PRICE_USD = 14
export const VOID_MIN_RELOAD_USD = 5

export const MAGMA_PRICE_LABEL = '$10 / month'
export const FROST_PRICE_LABEL = '$14 / month'
export const FREE_PRICE_LABEL = '$0'
export const VOID_MIN_RELOAD_LABEL = '$5 minimum reload'

/** Locked subscription model counts. */
export const FREE_MODEL_COUNT = 15
export const MAGMA_MODEL_COUNT = 25
export const FROST_MODEL_COUNT = 35

/** Locked LoopLink limits per base plan (Free/Magma/Frost). */
export const FREE_CHAIN_MAX = 5
export const MAGMA_CHAIN_MAX = 10
export const FROST_CHAIN_MAX = 15
/** LoopLink limit while the Void wallet is funded. */
export const FUNDED_VOID_CHAIN_MAX = 25

/**
 * Locked STARK Free billing list (exactly the 15 catalog models, in
 * product order). Billing may show these in an expandable section;
 * the Model Library remains the single execution-side catalog.
 */
export const FREE_BILLING_MODELS: readonly string[] = [
  'Muse Spark 1.3',
  'GLM-5.3 Flash',
  'DeepSeek V4.1 Flash',
  'GPT 5.6 Luna',
  'Gemini 2.5 Flash',
  'Claude Haiku 5.5',
  'MiniMax M3',
  'Kimi K2.7 Code',
  'MiMo-V2.6-Pro',
  'MiMo-V2.6-Flash',
  'Nemotron 3.5 Lightning',
  'DeepSeek V4 Flash',
  'Muse Spark 1.2',
  'LongCat 2.0',
  'Mistral Large 4'
]

/**
 * Locked Magma billing additions (models 16–25). BILLING INFORMATION
 * ONLY — do not add to Settings → Models in this pass.
 */
export const MAGMA_BILLING_MODELS: readonly string[] = [
  'GLM-5.3',
  'Qwen3.8 Max',
  'Kimi K3',
  'Grok 4.7',
  'Claude Sonnet 5',
  'GPT-6 Luna',
  'Gemini 3.8 Flash',
  'Qwen3.8 Flash',
  'GLM-5.2',
  'GPT-5.6 Terra'
]

/**
 * Locked Frost billing additions (models 26–35). BILLING INFORMATION
 * ONLY — do not add to Settings → Models in this pass.
 */
export const FROST_BILLING_MODELS: readonly string[] = [
  'GPT-6.1 Sol',
  'Claude Sonnet 5.5',
  'Claude Opus 5.5',
  'Gemini 3.1 Pro',
  'GPT-6 Sol',
  'Claude Opus 5',
  'GPT-6 Astra',
  'Step 5 Preview',
  'Nemotron 3 Ultra',
  'GPT-5.3 Codex'
]

/** Cumulative subscription models per base plan. */
export function subscriptionModelCount(plan: BasePlan): number {
  switch (plan) {
    case 'free':
      return FREE_MODEL_COUNT
    case 'magma':
      return MAGMA_MODEL_COUNT
    case 'frost':
      return FROST_MODEL_COUNT
  }
}

/**
 * Future seam for model-specific hosted usage allowances
 * (five-hour / weekly / monthly). Types only — no accounting, no
 * quota numbers, no balances in this pass.
 */
export interface ModelUsagePolicy {
  readonly modelId: string
  readonly fiveHourAllowance?: number
  readonly weeklyAllowance?: number
  readonly monthlyAllowance?: number
}

/** Calm billing copy for the not-yet-numbered hosted usage limits. */
export const HOSTED_USAGE_LIMITS_NOTE = 'Included hosted models have model-specific usage limits.'

/** Restrained fair-use footnote for unlimited fair-use benefits. */
export const FAIR_USE_FOOTNOTE = '*Subject to fair-use and technical limits.'

/** Free attachment/image quotas (displayed exactly). */
export const FREE_ATTACHMENT_QUOTA = '5 attachments / 12 hours'
export const FREE_IMAGE_QUOTA = '10 image generations / day'

/**
 * Narrow future billing action interface. No processor is selected;
 * the production implementation below is unavailable by design, and
 * the UI must stay honest about that.
 */
export interface BillingService {
  startSubscription(plan: 'magma' | 'frost'): Promise<never>
  openBillingPortal(): Promise<never>
  addVoidCredit(amountUsd: number): Promise<never>
}

/** Production billing service: not configured (no payment provider yet). */
export class UnavailableBillingService implements BillingService {
  startSubscription(): Promise<never> {
    return Promise.reject(new Error('Checkout is not configured yet.'))
  }
  openBillingPortal(): Promise<never> {
    return Promise.reject(new Error('Billing portal is not configured yet.'))
  }
  addVoidCredit(): Promise<never> {
    return Promise.reject(new Error('Void reloads are not configured yet.'))
  }
}
