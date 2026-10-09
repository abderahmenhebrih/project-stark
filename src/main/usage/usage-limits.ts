/**
 * Central bounds for Stage 28 local usage awareness.
 * Single definitions — no layer duplicates these numbers.
 */

import type { UsageThresholdRouteKey } from '../../shared/usage/types'

/** Rolling local usage window in milliseconds (24 hours, no scheduler). */
export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Local telemetry retention in days (one bounded startup delete). */
export const USAGE_EVENT_RETENTION_DAYS = 31

/** Most provider/model rows returned by one usage summary. */
export const MAX_USAGE_SUMMARY_MODELS = 100

/** Smallest user-configured max STARK calls per 24h. */
export const MIN_USAGE_MAX_CALLS = 1

/** Largest user-configured max STARK calls per 24h. */
export const MAX_USAGE_MAX_CALLS = 1_000_000

/** Smallest user-configured max reported tokens per 24h. */
export const MIN_USAGE_MAX_TOKENS = 1

/** Largest user-configured max reported tokens per 24h. */
export const MAX_USAGE_MAX_TOKENS = 1_000_000_000_000

/** Smallest routing switch percentage. */
export const MIN_USAGE_SWITCH_PERCENT = 1

/** Largest routing switch percentage. */
export const MAX_USAGE_SWITCH_PERCENT = 100

/** Every Heart route key that may hold a threshold alternate. */
export const USAGE_THRESHOLD_ROUTE_KEYS: readonly UsageThresholdRouteKey[] = [
  'brain.primary',
  'worker.fixed',
  'worker.default',
  'worker.general',
  'worker.coding',
  'worker.reasoning',
  'worker.fast'
]
