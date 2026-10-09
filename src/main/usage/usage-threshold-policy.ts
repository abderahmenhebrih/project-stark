/**
 * Pure deterministic Heart threshold-routing policy (Stage 28).
 *
 * Decides, BEFORE one provider call, whether a base Heart assignment
 * keeps serving or its single configured alternate serves instead.
 * Zero provider calls, zero DB effects, no loops, no recursion: one
 * base route maps to at most one alternate, and the alternate is
 * never itself threshold-evaluated for that decision.
 */

import type { UsageThresholdRouteKey } from '../../shared/usage/types'

/** Base or alternate assignment under consideration. */
export interface ThresholdAssignment {
  readonly providerId: string
  readonly model: string
}

/** Stable map key for one provider/model pair (unambiguous encoding). */
export function usagePairKey(providerId: string, model: string): string {
  return JSON.stringify([providerId, model])
}

/** Configured local limit for one provider/model (null = not configured). */
export interface ThresholdLimit {
  readonly maxCalls24h: number | null
  readonly maxTotalTokens24h: number | null
  readonly switchAtPercent: number
}

/** Observed 24-hour usage for one provider/model. */
export interface ThresholdUsage {
  readonly calls24h: number
  readonly tokens24h: number | null
  readonly tokenTelemetryComplete: boolean
}

/** Deterministic routing outcome (terminal — never re-evaluated). */
export interface ThresholdRouteDecision {
  readonly selected: ThresholdAssignment
  readonly decision: 'base' | 'threshold_alternate' | 'threshold_reached_no_alternate'
  readonly callsTriggered: boolean
  readonly tokensTriggered: boolean
}

/**
 * Overflow-safe `a * 100 >= b * percent` without floating point.
 * All inputs are bounded validated integers, so plain arithmetic is
 * exact within double precision.
 */
function atPercent(actual: number, configured: number, percent: number): boolean {
  return actual * 100 >= configured * percent
}

/** Trigger evaluation shared by routing and summary display. */
export function evaluateTriggers(
  usage: ThresholdUsage,
  limit: ThresholdLimit | null
): { callsTriggered: boolean; tokensTriggered: boolean; reached: boolean } {
  if (limit === null) {
    return { callsTriggered: false, tokensTriggered: false, reached: false }
  }
  const callsTriggered =
    limit.maxCalls24h !== null && atPercent(usage.calls24h, limit.maxCalls24h, limit.switchAtPercent)
  const tokensTriggered =
    limit.maxTotalTokens24h !== null &&
    usage.tokenTelemetryComplete &&
    usage.tokens24h !== null &&
    atPercent(usage.tokens24h, limit.maxTotalTokens24h, limit.switchAtPercent)
  return { callsTriggered, tokensTriggered, reached: callsTriggered || tokensTriggered }
}

/**
 * Applies the local threshold policy exactly once. When routing is
 * disabled, when no limit is configured, or when neither trigger
 * fires, the base assignment serves (`base`). When a trigger fires
 * with a configured alternate, the alternate serves
 * (`threshold_alternate`). When a trigger fires without an
 * alternate, the base still serves (`threshold_reached_no_alternate`)
 * — thresholds switch routes, they never block requests.
 *
 * Token triggers require complete telemetry; incomplete token data
 * never switches on tokens (call-count triggers still apply).
 */
export function decideThresholdRoute(input: {
  readonly enabled: boolean
  readonly routeKey: UsageThresholdRouteKey
  readonly base: ThresholdAssignment
  readonly alternate: ThresholdAssignment | null
  readonly usage: ThresholdUsage
  readonly limit: ThresholdLimit | null
}): ThresholdRouteDecision {
  void input.routeKey
  if (!input.enabled || input.limit === null) {
    return { selected: input.base, decision: 'base', callsTriggered: false, tokensTriggered: false }
  }
  const { callsTriggered, tokensTriggered } = evaluateTriggers(input.usage, input.limit)
  if (!callsTriggered && !tokensTriggered) {
    return { selected: input.base, decision: 'base', callsTriggered: false, tokensTriggered: false }
  }
  if (input.alternate === null) {
    return { selected: input.base, decision: 'threshold_reached_no_alternate', callsTriggered, tokensTriggered }
  }
  return { selected: input.alternate, decision: 'threshold_alternate', callsTriggered, tokensTriggered }
}
