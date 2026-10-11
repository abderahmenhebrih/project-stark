/**
 * STARK sponsored-working economics / coverage seam.
 *
 * Future question: sponsor revenue ÷ actual Free inference COGS.
 * Today both values are UNKNOWN in production — no fake dollars, no
 * coverage claims. This module is the TYPE/INTERFACE seam only; tests
 * use synthetic numeric fixtures.
 *
 * coverageRatio = sponsorRevenue / inferenceCost, with:
 * - unknown revenue or cost (undefined) → null
 * - cost === 0                           → null (no divide-by-zero)
 * - negative / non-finite inputs         → null
 */

import type { InferenceEconomics, SponsorEconomics } from './sponsor-types'

/** Synthetic-test helper: revenue in micros of currency. */
export function sponsorRevenueMicros(value: number): SponsorEconomics {
  return { revenueMicros: value }
}

/** Synthetic-test helper: inference cost in micros of currency. */
export function inferenceCostMicros(value: number): InferenceEconomics {
  return { actualCostMicros: value }
}

function isValidMoneyMicros(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Computes revenue ÷ cost coverage. Returns null when coverage is
 * unknown or unsafe (missing values, zero cost, invalid inputs).
 */
export function computeCoverageRatio(
  revenue: SponsorEconomics,
  cost: InferenceEconomics
): number | null {
  const revenueMicros = revenue.revenueMicros
  const costMicros = cost.actualCostMicros
  if (!isValidMoneyMicros(revenueMicros) || !isValidMoneyMicros(costMicros)) {
    return null
  }
  if (costMicros === 0) {
    return null
  }
  return revenueMicros / costMicros
}
