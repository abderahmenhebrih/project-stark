/**
 * Shared local usage-awareness contract (Stage 28).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * STARK tracks only provider calls made by STARK. It does not query
 * provider billing or quota APIs and cannot see usage generated
 * outside STARK. Token counts are shown only when the provider
 * reports them — STARK never estimates missing token usage.
 */

/** Heart route keys that may each hold at most one threshold alternate. */
export type UsageThresholdRouteKey =
  | 'brain.primary'
  | 'worker.fixed'
  | 'worker.default'
  | 'worker.general'
  | 'worker.coding'
  | 'worker.reasoning'
  | 'worker.fast'

/** Deterministic usage-routing decision persisted per run role. */
export type UsageRouteDecisionKind = 'base' | 'threshold_alternate' | 'threshold_reached_no_alternate'

/** One persisted Heart usage-routing decision, rendered inertly. */
export interface UsageRouteDecision {
  readonly role: 'brain' | 'worker'
  readonly routeKey: string
  readonly baseProviderId: string
  readonly baseModel: string
  readonly selectedProviderId: string
  readonly selectedModel: string
  readonly decision: UsageRouteDecisionKind
  readonly calls24h: number
  readonly tokens24h: number | null
  readonly tokenTelemetryComplete: boolean
  readonly snapshotAt: number
}

/** One user-configured local routing threshold (never a provider quota). */
export interface UsageLimitEntry {
  readonly providerId: string
  readonly model: string
  readonly maxCalls24h: number | null
  readonly maxTotalTokens24h: number | null
  readonly switchAtPercent: number
}

/** One configured threshold alternate (at most one per route key). */
export interface UsageAlternateEntry {
  readonly routeKey: UsageThresholdRouteKey
  readonly providerId: string
  readonly model: string
}

/** Complete usage-routing configuration (explicit save only). */
export interface UsageConfig {
  readonly heartThresholdRoutingEnabled: boolean
  readonly limits: readonly UsageLimitEntry[]
  readonly alternates: readonly UsageAlternateEntry[]
}

/** Complete replacement save (no extra fields accepted). */
export interface UpdateUsageConfigRequest {
  readonly heartThresholdRoutingEnabled: boolean
  readonly limits: readonly UsageLimitEntry[]
  readonly alternates: readonly UsageAlternateEntry[]
}

/** One bounded per-model 24-hour local summary row. */
export interface UsageModelSummary {
  readonly providerId: string
  readonly model: string
  readonly calls24h: number
  readonly successes24h: number
  readonly failures24h: number
  readonly rateLimitFailures24h: number
  readonly inputTokens24h: number | null
  readonly outputTokens24h: number | null
  readonly totalTokens24h: number | null
  readonly tokenTelemetryComplete: boolean
  readonly maxCalls24h: number | null
  readonly maxTotalTokens24h: number | null
  readonly switchAtPercent: number | null
  readonly callsThresholdReached: boolean
  readonly tokensThresholdReached: boolean
  readonly thresholdReached: boolean
}

/** Bounded local last-24-hour summary (local DB aggregation only). */
export interface UsageSummary {
  readonly models: readonly UsageModelSummary[]
  readonly truncated: boolean
  readonly windowMs: number
  readonly heartThresholdRoutingEnabled: boolean
}

/** Usage slice of the preload bridge (`window.stark.usage`). */
export interface UsageApi {
  getConfig: () => Promise<UsageConfig>
  updateConfig: (config: UpdateUsageConfigRequest) => Promise<UsageConfig>
  getSummary: () => Promise<UsageSummary>
}
