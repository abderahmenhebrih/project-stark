import type { ProviderRegistry } from '../ai/provider-adapter'
import type {
  UsageConfig,
  UsageModelSummary,
  UsageRouteDecision,
  UsageSummary,
  UsageThresholdRouteKey,
  UpdateUsageConfigRequest
} from '../../shared/usage/types'
import { MAX_HEART_MODEL_ID_CODEPOINTS, MAX_HEART_PROVIDER_ID_CODEPOINTS } from '../heart/heart-limits'
import { AiUsageRepository } from './ai-usage-repository'
import { InvalidUsageConfigError, InvalidUsageRequestError } from './ai-usage-errors'
import {
  MAX_USAGE_MAX_CALLS,
  MAX_USAGE_MAX_TOKENS,
  MAX_USAGE_SUMMARY_MODELS,
  MAX_USAGE_SWITCH_PERCENT,
  MIN_USAGE_MAX_CALLS,
  MIN_USAGE_MAX_TOKENS,
  MIN_USAGE_SWITCH_PERCENT,
  USAGE_EVENT_RETENTION_DAYS,
  USAGE_THRESHOLD_ROUTE_KEYS,
  USAGE_WINDOW_MS
} from './usage-limits'
import { evaluateTriggers, usagePairKey } from './usage-threshold-policy'
import type { ThresholdLimit, ThresholdUsage } from './usage-threshold-policy'

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function countCodePoints(value: string): number {
  return [...value].length
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function isValidId(value: unknown, maxCodePoints: number): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('\0') &&
    !hasUnpairedSurrogate(value) &&
    countCodePoints(value) <= maxCodePoints
  )
}

function isValidRouteKey(value: unknown): value is UsageThresholdRouteKey {
  return typeof value === 'string' && (USAGE_THRESHOLD_ROUTE_KEYS as readonly string[]).includes(value)
}

function isValidSwitchPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_USAGE_SWITCH_PERCENT &&
    value <= MAX_USAGE_SWITCH_PERCENT
  )
}

function parseOptionalBoundedInt(value: unknown, min: number, max: number, what: string): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidUsageConfigError(`The usage routing ${what} is invalid.`)
  }
  return value
}

/** Work-start routing snapshot: frozen config + per-assignment usage. */
export interface WorkUsageSnapshot {
  readonly enabled: boolean
  readonly snapshotAt: number
  readonly summaries: ReadonlyMap<string, { usage: ThresholdUsage; limit: ThresholdLimit | null }>
  readonly alternates: ReadonlyMap<string, { providerId: string; model: string }>
}

/**
 * Usage configuration + local aggregation service (Stage 28).
 * Validates and atomically saves complete routing configs,
 * aggregates the rolling 24-hour local summary from STARK's own
 * call ledger, and captures frozen Work-start routing snapshots.
 * Zero provider calls — local SQLite only. Tables hold IDs and
 * counters only: no prompts, results, keys, or bodies.
 */
export class AiUsageService {
  private readonly now: () => number
  private readonly heartBaseResolver:
    | ((routeKey: UsageThresholdRouteKey) => { providerId: string; model: string } | null)
    | undefined

  constructor(
    private readonly store: AiUsageRepository,
    private readonly registry: ProviderRegistry,
    options?: {
      now?: () => number
      /** Resolves current Heart base assignments for alternate-identity checks. */
      heartBaseResolver?: (routeKey: UsageThresholdRouteKey) => { providerId: string; model: string } | null
    }
  ) {
    this.now = options?.now ?? Date.now
    this.heartBaseResolver = options?.heartBaseResolver
  }

  /** Complete usage-routing configuration (defaults when never saved). */
  getConfig(): UsageConfig {
    const settings = this.store.findSettings()
    return {
      heartThresholdRoutingEnabled: settings?.thresholdRoutingEnabled ?? false,
      limits: this.store.listLimits().map((row) => ({
        providerId: row.providerId,
        model: row.model,
        maxCalls24h: row.maxCalls24h,
        maxTotalTokens24h: row.maxTotalTokens24h,
        switchAtPercent: row.switchAtPercent
      })),
      alternates: this.store.listAlternates().map((row) => ({
        routeKey: row.routeKey as UsageThresholdRouteKey,
        providerId: row.providerId,
        model: row.model
      }))
    }
  }

  /** Validates and atomically saves a complete usage-routing configuration. */
  updateConfig(raw: unknown): UsageConfig {
    if (!hasStrictShape(raw, ['heartThresholdRoutingEnabled', 'limits', 'alternates'])) {
      throw new InvalidUsageConfigError()
    }
    const record = raw as Record<string, unknown>
    const { heartThresholdRoutingEnabled, limits, alternates } = record
    if (typeof heartThresholdRoutingEnabled !== 'boolean') {
      throw new InvalidUsageConfigError()
    }
    if (!Array.isArray(limits) || !Array.isArray(alternates)) {
      throw new InvalidUsageConfigError()
    }
    const normalizedLimits = limits.map((entry) => this.parseLimit(entry))
    const seenLimits = new Set<string>()
    for (const entry of normalizedLimits) {
      const key = usagePairKey(entry.providerId, entry.model)
      if (seenLimits.has(key)) {
        throw new InvalidUsageConfigError('The usage routing limits contain a duplicate.')
      }
      seenLimits.add(key)
    }
    const normalizedAlternates = alternates.map((entry) => this.parseAlternate(entry))
    const seenRoutes = new Set<string>()
    for (const entry of normalizedAlternates) {
      if (seenRoutes.has(entry.routeKey)) {
        throw new InvalidUsageConfigError('The usage routing alternates contain a duplicate route.')
      }
      seenRoutes.add(entry.routeKey)
    }
    this.store.replaceConfig({
      thresholdRoutingEnabled: heartThresholdRoutingEnabled,
      limits: normalizedLimits,
      alternates: normalizedAlternates,
      now: this.now()
    })
    return this.getConfig()
  }

  /**
   * Bounded local last-24-hour summary over STARK-observed traffic
   * plus configured limits/alternates and the given Heart
   * assignments. One local aggregation query — zero provider calls.
   */
  get24HourSummary(heartAssignments: readonly { providerId: string; model: string }[]): UsageSummary {
    const now = this.now()
    const aggregates = this.store.summarizeWindow(now - USAGE_WINDOW_MS)
    const byPair = new Map(aggregates.map((row) => [usagePairKey(row.providerId, row.model), row]))
    const limits = new Map(this.store.listLimits().map((row) => [usagePairKey(row.providerId, row.model), row]))
    const alternates = this.store.listAlternates()
    const wanted = new Map<string, { providerId: string; model: string }>()
    const add = (providerId: string, model: string): void => {
      const key = usagePairKey(providerId, model)
      if (!wanted.has(key)) {
        wanted.set(key, { providerId, model })
      }
    }
    for (const row of aggregates) {
      add(row.providerId, row.model)
    }
    for (const row of this.store.listLimits()) {
      add(row.providerId, row.model)
    }
    for (const row of alternates) {
      add(row.providerId, row.model)
    }
    for (const assignment of heartAssignments) {
      add(assignment.providerId, assignment.model)
    }
    const pairs = [...wanted.values()].slice(0, MAX_USAGE_SUMMARY_MODELS + 1)
    const truncated = pairs.length > MAX_USAGE_SUMMARY_MODELS
    const models: UsageModelSummary[] = pairs.slice(0, MAX_USAGE_SUMMARY_MODELS).map(({ providerId, model }) => {
      const aggregate = byPair.get(usagePairKey(providerId, model))
      const limit = limits.get(usagePairKey(providerId, model))
      const successes = aggregate?.successes ?? 0
      const complete =
        successes === 0 || (aggregate !== undefined && aggregate.successesWithTotalTokens === successes)
      const usage: ThresholdUsage = {
        calls24h: aggregate?.calls ?? 0,
        tokens24h: successes === 0 ? 0 : (aggregate?.totalTokens ?? null),
        tokenTelemetryComplete: complete
      }
      const thresholdLimit: ThresholdLimit | null =
        limit === undefined
          ? null
          : { maxCalls24h: limit.maxCalls24h, maxTotalTokens24h: limit.maxTotalTokens24h, switchAtPercent: limit.switchAtPercent }
      const triggers = evaluateTriggers(usage, thresholdLimit)
      return {
        providerId,
        model,
        calls24h: usage.calls24h,
        successes24h: successes,
        failures24h: aggregate?.failures ?? 0,
        rateLimitFailures24h: aggregate?.rateLimitFailures ?? 0,
        inputTokens24h: successes === 0 ? 0 : (aggregate?.inputTokens ?? null),
        outputTokens24h: successes === 0 ? 0 : (aggregate?.outputTokens ?? null),
        totalTokens24h: usage.tokens24h,
        tokenTelemetryComplete: complete,
        maxCalls24h: thresholdLimit?.maxCalls24h ?? null,
        maxTotalTokens24h: thresholdLimit?.maxTotalTokens24h ?? null,
        switchAtPercent: thresholdLimit?.switchAtPercent ?? null,
        callsThresholdReached: triggers.callsTriggered,
        tokensThresholdReached: triggers.tokensTriggered,
        thresholdReached: triggers.reached
      }
    })
    return {
      models,
      truncated,
      windowMs: USAGE_WINDOW_MS,
      heartThresholdRoutingEnabled: this.store.findSettings()?.thresholdRoutingEnabled ?? false
    }
  }

  /**
   * Captures a frozen Work-start routing snapshot for exactly the
   * given assignments: enabled flag, per-pair usage + limit, and
   * alternates. Runners resolve routes from this snapshot only —
   * never fresh queries mid-run.
   */
  snapshotForWork(assignments: readonly { providerId: string; model: string }[]): WorkUsageSnapshot {
    const now = this.now()
    const settings = this.store.findSettings()
    const aggregates = new Map(
      this.store.summarizeWindow(now - USAGE_WINDOW_MS).map((row) => [usagePairKey(row.providerId, row.model), row])
    )
    const limits = new Map(this.store.listLimits().map((row) => [usagePairKey(row.providerId, row.model), row]))
    const summaries = new Map<string, { usage: ThresholdUsage; limit: ThresholdLimit | null }>()
    for (const assignment of assignments) {
      const key = usagePairKey(assignment.providerId, assignment.model)
      if (summaries.has(key)) {
        continue
      }
      const aggregate = aggregates.get(key)
      const limitRow = limits.get(key)
      const successes = aggregate?.successes ?? 0
      const complete =
        successes === 0 || (aggregate !== undefined && aggregate.successesWithTotalTokens === successes)
      summaries.set(key, {
        usage: {
          calls24h: aggregate?.calls ?? 0,
          tokens24h: successes === 0 ? 0 : (aggregate?.totalTokens ?? null),
          tokenTelemetryComplete: complete
        },
        limit:
          limitRow === undefined
            ? null
            : {
                maxCalls24h: limitRow.maxCalls24h,
                maxTotalTokens24h: limitRow.maxTotalTokens24h,
                switchAtPercent: limitRow.switchAtPercent
              }
      })
    }
    const alternates = new Map(
      this.store.listAlternates().map((row) => [row.routeKey, { providerId: row.providerId, model: row.model }])
    )
    return { enabled: settings?.thresholdRoutingEnabled ?? false, snapshotAt: now, summaries, alternates }
  }

  /** Route decisions for one run (empty for runs that predate Stage 28). */
  decisionsForRun(runId: number): UsageRouteDecision[] {
    if (!Number.isInteger(runId) || runId <= 0) {
      throw new InvalidUsageRequestError('run reference is invalid')
    }
    return this.store.findDecisionsByRun(runId).map((row) => ({
      role: row.role as 'brain' | 'worker',
      routeKey: row.routeKey,
      baseProviderId: row.baseProviderId,
      baseModel: row.baseModel,
      selectedProviderId: row.selectedProviderId,
      selectedModel: row.selectedModel,
      decision: row.decision as UsageRouteDecision['decision'],
      calls24h: row.calls24h,
      tokens24h: row.tokens24h,
      tokenTelemetryComplete: row.tokenTelemetryComplete,
      snapshotAt: row.snapshotAt
    }))
  }

  /**
   * Persists one deterministic Heart usage-routing decision. Runners
   * call this best-effort (audit must never break a run); at most one
   * row per (run, role) by construction.
   */
  recordDecision(input: {
    runId: number
    role: string
    routeKey: string
    baseProviderId: string
    baseModel: string
    selectedProviderId: string
    selectedModel: string
    decision: string
    calls24h: number
    tokens24h: number | null
    tokenTelemetryComplete: boolean
    maxCalls24h: number | null
    maxTotalTokens24h: number | null
    switchAtPercent: number | null
    callsTriggered: boolean
    tokensTriggered: boolean
    snapshotAt: number
    now: number
  }): number {
    return this.store.insertDecision(input)
  }

  /**
   * One bounded startup pass: prune telemetry older than 31 days and
   * mark leftover `started` events interrupted. No provider calls,
   * no retries, no timers.
   */
  startupCleanup(now: number): { pruned: number; interrupted: number } {
    const pruned = this.store.deleteOlderThan(now - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).deleted
    const interrupted = this.store.markStartedAsInterrupted(now).interrupted
    return { pruned, interrupted }
  }

  private parseLimit(entry: unknown): {
    providerId: string
    model: string
    maxCalls24h: number | null
    maxTotalTokens24h: number | null
    switchAtPercent: number
  } {
    if (!hasStrictShape(entry, ['providerId', 'model', 'maxCalls24h', 'maxTotalTokens24h', 'switchAtPercent'])) {
      throw new InvalidUsageConfigError()
    }
    const record = entry as Record<string, unknown>
    const providerId = record['providerId']
    const model = record['model']
    if (!isValidId(providerId, MAX_HEART_PROVIDER_ID_CODEPOINTS) || !this.registry.isKnown(providerId)) {
      throw new InvalidUsageConfigError('The usage routing provider is invalid.')
    }
    if (!isValidId(model, MAX_HEART_MODEL_ID_CODEPOINTS)) {
      throw new InvalidUsageConfigError('The usage routing model is invalid.')
    }
    const maxCalls24h = parseOptionalBoundedInt(record['maxCalls24h'], MIN_USAGE_MAX_CALLS, MAX_USAGE_MAX_CALLS, 'call limit')
    const maxTotalTokens24h = parseOptionalBoundedInt(
      record['maxTotalTokens24h'],
      MIN_USAGE_MAX_TOKENS,
      MAX_USAGE_MAX_TOKENS,
      'token limit'
    )
    if (maxCalls24h === null && maxTotalTokens24h === null) {
      throw new InvalidUsageConfigError('The usage routing limit needs at least one bound.')
    }
    const switchAtPercent = record['switchAtPercent']
    if (!isValidSwitchPercent(switchAtPercent)) {
      throw new InvalidUsageConfigError('The usage routing switch percentage is invalid.')
    }
    return { providerId, model, maxCalls24h, maxTotalTokens24h, switchAtPercent }
  }

  private parseAlternate(entry: unknown): { routeKey: UsageThresholdRouteKey; providerId: string; model: string } {
    if (!hasStrictShape(entry, ['routeKey', 'providerId', 'model'])) {
      throw new InvalidUsageConfigError()
    }
    const record = entry as Record<string, unknown>
    const routeKey = record['routeKey']
    const providerId = record['providerId']
    const model = record['model']
    if (!isValidRouteKey(routeKey)) {
      throw new InvalidUsageConfigError('The usage routing alternate route is invalid.')
    }
    if (!isValidId(providerId, MAX_HEART_PROVIDER_ID_CODEPOINTS) || !this.registry.isKnown(providerId as string)) {
      throw new InvalidUsageConfigError('The usage routing provider is invalid.')
    }
    if (!isValidId(model, MAX_HEART_MODEL_ID_CODEPOINTS)) {
      throw new InvalidUsageConfigError('The usage routing model is invalid.')
    }
    const base = this.heartBaseResolver?.(routeKey) ?? null
    if (base !== null && base.providerId === providerId && base.model === model) {
      throw new InvalidUsageConfigError('The threshold alternate must differ from the current Heart route.')
    }
    return { routeKey, providerId: providerId as string, model: model as string }
  }
}

/** Validates an update payload shape for IPC use (service re-validates). */
export function validateUsageUpdateRequest(raw: unknown): UpdateUsageConfigRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidUsageConfigError()
  }
  return raw as UpdateUsageConfigRequest
}

/** Validates an empty exact-shape payload for get-config/get-summary. */
export function validateUsageEmptyRequest(raw: unknown): Record<string, never> {
  if (raw === undefined) {
    return {}
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    return {}
  }
  throw new InvalidUsageRequestError('The usage request is invalid.')
}
