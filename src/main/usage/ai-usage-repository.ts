import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'
import { usagePairKey } from './usage-threshold-policy'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNullableNumber(value: unknown, what: string): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number') {
    throw new DatabaseError(`stored usage ${what} is invalid`)
  }
  return value
}

/** Raw usage-event row (metadata/counters only — never prompts or results). */
export interface StoredUsageEvent {
  readonly id: number
  readonly providerId: string
  readonly model: string
  readonly operation: string
  readonly role: string | null
  readonly workspaceId: number | null
  readonly sessionId: number | null
  readonly runId: number | null
  readonly status: string
  readonly failureCategory: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly latencyMs: number | null
  readonly createdAt: number
  readonly completedAt: number | null
}

/** Raw usage-settings singleton row. */
export interface StoredUsageSettings {
  readonly thresholdRoutingEnabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw usage-limit row (user-defined local routing threshold). */
export interface StoredUsageLimit {
  readonly providerId: string
  readonly model: string
  readonly maxCalls24h: number | null
  readonly maxTotalTokens24h: number | null
  readonly switchAtPercent: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw Heart threshold-alternate row (at most one per route key). */
export interface StoredUsageAlternate {
  readonly routeKey: string
  readonly providerId: string
  readonly model: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw usage route-decision audit row (immutable once written). */
export interface StoredUsageDecision {
  readonly id: number
  readonly runId: number
  readonly role: string
  readonly routeKey: string
  readonly baseProviderId: string
  readonly baseModel: string
  readonly selectedProviderId: string
  readonly selectedModel: string
  readonly decision: string
  readonly calls24h: number
  readonly tokens24h: number | null
  readonly tokenTelemetryComplete: boolean
  readonly maxCalls24h: number | null
  readonly maxTotalTokens24h: number | null
  readonly switchAtPercent: number | null
  readonly callsTriggered: boolean
  readonly tokensTriggered: boolean
  readonly snapshotAt: number
  readonly createdAt: number
}

function mapDecision(row: unknown): StoredUsageDecision {
  if (!isRecord(row)) {
    throw new DatabaseError('stored usage decision row is invalid')
  }
  const id = row['id']
  const runId = row['orchestration_run_id']
  const role = row['role']
  const routeKey = row['route_key']
  const baseProviderId = row['base_provider_id']
  const baseModel = row['base_model']
  const selectedProviderId = row['selected_provider_id']
  const selectedModel = row['selected_model']
  const decision = row['decision']
  const calls24h = row['calls_24h']
  const snapshotAt = row['snapshot_at']
  const createdAt = row['created_at']
  const tokenComplete = row['token_telemetry_complete']
  const callsTriggered = row['calls_triggered']
  const tokensTriggered = row['tokens_triggered']
  if (
    typeof id !== 'number' ||
    typeof runId !== 'number' ||
    typeof role !== 'string' ||
    typeof routeKey !== 'string' ||
    typeof baseProviderId !== 'string' ||
    typeof baseModel !== 'string' ||
    typeof selectedProviderId !== 'string' ||
    typeof selectedModel !== 'string' ||
    typeof decision !== 'string' ||
    typeof calls24h !== 'number' ||
    typeof snapshotAt !== 'number' ||
    typeof createdAt !== 'number' ||
    (tokenComplete !== 0 && tokenComplete !== 1) ||
    (callsTriggered !== 0 && callsTriggered !== 1) ||
    (tokensTriggered !== 0 && tokensTriggered !== 1)
  ) {
    throw new DatabaseError('stored usage decision row is invalid')
  }
  return {
    id,
    runId,
    role,
    routeKey,
    baseProviderId,
    baseModel,
    selectedProviderId,
    selectedModel,
    decision,
    calls24h,
    tokens24h: asNullableNumber(row['tokens_24h'], 'decision row'),
    tokenTelemetryComplete: tokenComplete === 1,
    maxCalls24h: asNullableNumber(row['max_calls_24h'], 'decision row'),
    maxTotalTokens24h: asNullableNumber(row['max_total_tokens_24h'], 'decision row'),
    switchAtPercent: asNullableNumber(row['switch_at_percent'], 'decision row'),
    callsTriggered: callsTriggered === 1,
    tokensTriggered: tokensTriggered === 1,
    snapshotAt,
    createdAt
  }
}

/** One aggregated provider/model row for the rolling 24-hour window. */
export interface UsageAggregateRow {
  readonly providerId: string
  readonly model: string
  readonly calls: number
  readonly successes: number
  readonly failures: number
  readonly rateLimitFailures: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly successesWithTotalTokens: number
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored usage ${what} is invalid`)
  }
  return numeric
}

/**
 * Typed main-process repository over ai_usage_events,
 * ai_usage_settings, ai_usage_limits, ai_heart_threshold_alternates,
 * and ai_usage_route_decisions. Persistence only: no validation
 * beyond row shapes, no provider calls, no credentials, no prompt or
 * result content anywhere. Config saves run in ONE SQLite
 * transaction with complete-replacement semantics. Fault injection
 * is test-only.
 */
export class AiUsageRepository {
  private readonly db: DatabaseSync
  private readonly reserveEventStmt: StatementSync
  private readonly finalizeSuccessStmt: StatementSync
  private readonly finalizeFailureStmt: StatementSync
  private readonly findSettingsStmt: StatementSync
  private readonly upsertSettingsStmt: StatementSync
  private readonly listLimitsStmt: StatementSync
  private readonly upsertLimitStmt: StatementSync
  private readonly deleteLimitStmt: StatementSync
  private readonly listAlternatesStmt: StatementSync
  private readonly upsertAlternateStmt: StatementSync
  private readonly deleteAlternateStmt: StatementSync
  private readonly insertDecisionStmt: StatementSync
  private readonly findDecisionsStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.reserveEventStmt = db.prepare(
      'INSERT INTO ai_usage_events (provider_id, model, operation, role, workspace_id, session_id, ' +
        'orchestration_run_id, status, failure_category, input_tokens, output_tokens, total_tokens, ' +
        'latency_ms, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.finalizeSuccessStmt = db.prepare(
      'UPDATE ai_usage_events SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, ' +
        'latency_ms = ?, completed_at = ? WHERE id = ?'
    )
    this.finalizeFailureStmt = db.prepare(
      'UPDATE ai_usage_events SET status = ?, failure_category = ?, latency_ms = ?, completed_at = ? WHERE id = ?'
    )
    this.findSettingsStmt = db.prepare(
      'SELECT heart_threshold_routing_enabled, created_at, updated_at FROM ai_usage_settings WHERE id = 1'
    )
    this.upsertSettingsStmt = db.prepare(
      'INSERT INTO ai_usage_settings (id, heart_threshold_routing_enabled, created_at, updated_at) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET heart_threshold_routing_enabled = excluded.heart_threshold_routing_enabled, ' +
        'updated_at = excluded.updated_at'
    )
    this.listLimitsStmt = db.prepare(
      'SELECT provider_id, model, max_calls_24h, max_total_tokens_24h, switch_at_percent, created_at, updated_at ' +
        'FROM ai_usage_limits'
    )
    this.upsertLimitStmt = db.prepare(
      'INSERT INTO ai_usage_limits (provider_id, model, max_calls_24h, max_total_tokens_24h, switch_at_percent, ' +
        'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(provider_id, model) DO UPDATE SET max_calls_24h = excluded.max_calls_24h, ' +
        'max_total_tokens_24h = excluded.max_total_tokens_24h, switch_at_percent = excluded.switch_at_percent, ' +
        'updated_at = excluded.updated_at'
    )
    this.deleteLimitStmt = db.prepare('DELETE FROM ai_usage_limits WHERE provider_id = ? AND model = ?')
    this.listAlternatesStmt = db.prepare(
      'SELECT route_key, provider_id, model, created_at, updated_at FROM ai_heart_threshold_alternates'
    )
    this.upsertAlternateStmt = db.prepare(
      'INSERT INTO ai_heart_threshold_alternates (route_key, provider_id, model, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(route_key) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, ' +
        'updated_at = excluded.updated_at'
    )
    this.deleteAlternateStmt = db.prepare('DELETE FROM ai_heart_threshold_alternates WHERE route_key = ?')
    this.insertDecisionStmt = db.prepare(
      'INSERT INTO ai_usage_route_decisions (orchestration_run_id, role, route_key, base_provider_id, base_model, ' +
        'selected_provider_id, selected_model, decision, calls_24h, tokens_24h, token_telemetry_complete, ' +
        'max_calls_24h, max_total_tokens_24h, switch_at_percent, calls_triggered, tokens_triggered, snapshot_at, ' +
        'created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.findDecisionsStmt = db.prepare(
      'SELECT id, orchestration_run_id, role, route_key, base_provider_id, base_model, selected_provider_id, ' +
        'selected_model, decision, calls_24h, tokens_24h, token_telemetry_complete, max_calls_24h, ' +
        'max_total_tokens_24h, switch_at_percent, calls_triggered, tokens_triggered, snapshot_at, created_at ' +
        'FROM ai_usage_route_decisions WHERE orchestration_run_id = ? ORDER BY id ASC'
    )
  }

  /**
   * Reserves one usage event as `started` before the outbound call.
   * Returns the event id. Throws on DB failure — callers must still
   * perform the single provider call (telemetry never blocks or
   * duplicates model operations).
   */
  reserveEvent(
    input: {
      providerId: string
      model: string
      operation: string
      role: string | null
      workspaceId: number | null
      sessionId: number | null
      runId: number | null
      now: number
    },
    fault?: { readonly throwBeforeInsert: boolean }
  ): { id: number } {
    if (fault?.throwBeforeInsert === true) {
      throw new DatabaseError('injected usage reserve fault')
    }
    const result = this.reserveEventStmt.run(
      input.providerId, input.model, input.operation, input.role,
      input.workspaceId, input.sessionId, input.runId,
      'started', null, null, null, null, null, input.now, null
    )
    return { id: toRowId(result.lastInsertRowid, 'event id') }
  }

  /** Finalizes one reserved event as a successful call with reported usage. */
  finalizeSuccess(
    id: number,
    input: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; latencyMs: number; now: number },
    fault?: { readonly throwBeforeUpdate: boolean }
  ): void {
    if (fault?.throwBeforeUpdate === true) {
      throw new DatabaseError('injected usage finalize fault')
    }
    this.finalizeSuccessStmt.run('success', input.inputTokens, input.outputTokens, input.totalTokens, input.latencyMs, input.now, id)
  }

  /** Finalizes one reserved event as a failed call with a safe category. */
  finalizeFailure(
    id: number,
    input: { failureCategory: string; latencyMs: number; now: number },
    fault?: { readonly throwBeforeUpdate: boolean }
  ): void {
    if (fault?.throwBeforeUpdate === true) {
      throw new DatabaseError('injected usage finalize fault')
    }
    this.finalizeFailureStmt.run('failed', input.failureCategory, input.latencyMs, input.now, id)
  }

  /** Usage-settings singleton, or undefined before first save. */
  findSettings(): StoredUsageSettings | undefined {
    const row: unknown = this.findSettingsStmt.get()
    if (row === undefined) {
      return undefined
    }
    if (!isRecord(row)) {
      throw new DatabaseError('stored usage settings row is invalid')
    }
    const enabled = row['heart_threshold_routing_enabled']
    const createdAt = row['created_at']
    const updatedAt = row['updated_at']
    if ((enabled !== 0 && enabled !== 1) || typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
      throw new DatabaseError('stored usage settings row is invalid')
    }
    return { thresholdRoutingEnabled: enabled === 1, createdAt, updatedAt }
  }

  /** All configured usage limits. */
  listLimits(): StoredUsageLimit[] {
    const rows: unknown = this.listLimitsStmt.all()
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored usage limit rows are invalid')
    }
    return rows.map((row: unknown) => {
      if (!isRecord(row)) {
        throw new DatabaseError('stored usage limit row is invalid')
      }
      const providerId = row['provider_id']
      const model = row['model']
      const switchAtPercent = row['switch_at_percent']
      const createdAt = row['created_at']
      const updatedAt = row['updated_at']
      if (
        typeof providerId !== 'string' ||
        typeof model !== 'string' ||
        typeof switchAtPercent !== 'number' ||
        typeof createdAt !== 'number' ||
        typeof updatedAt !== 'number'
      ) {
        throw new DatabaseError('stored usage limit row is invalid')
      }
      return {
        providerId,
        model,
        maxCalls24h: asNullableNumber(row['max_calls_24h'], 'limit row'),
        maxTotalTokens24h: asNullableNumber(row['max_total_tokens_24h'], 'limit row'),
        switchAtPercent,
        createdAt,
        updatedAt
      }
    })
  }

  /** All configured Heart threshold alternates. */
  listAlternates(): StoredUsageAlternate[] {
    const rows: unknown = this.listAlternatesStmt.all()
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored usage alternate rows are invalid')
    }
    return rows.map((row: unknown) => {
      if (!isRecord(row)) {
        throw new DatabaseError('stored usage alternate row is invalid')
      }
      const routeKey = row['route_key']
      const providerId = row['provider_id']
      const model = row['model']
      const createdAt = row['created_at']
      const updatedAt = row['updated_at']
      if (
        typeof routeKey !== 'string' ||
        typeof providerId !== 'string' ||
        typeof model !== 'string' ||
        typeof createdAt !== 'number' ||
        typeof updatedAt !== 'number'
      ) {
        throw new DatabaseError('stored usage alternate row is invalid')
      }
      return { routeKey, providerId, model, createdAt, updatedAt }
    })
  }

  /**
   * Atomically replaces the complete usage-routing configuration:
   * settings plus exactly the given limits and alternates (stale rows
   * removed). Either everything lands or nothing does.
   */
  replaceConfig(
    input: {
      thresholdRoutingEnabled: boolean
      limits: { providerId: string; model: string; maxCalls24h: number | null; maxTotalTokens24h: number | null; switchAtPercent: number }[]
      alternates: { routeKey: string; providerId: string; model: string }[]
      now: number
    },
    fault?: { readonly failAfterLimits: number }
  ): void {
    this.db.exec('BEGIN')
    try {
      this.upsertSettingsStmt.run(input.thresholdRoutingEnabled ? 1 : 0, input.now, input.now)
      const wantedLimits = new Set(input.limits.map((entry) => usagePairKey(entry.providerId, entry.model)))
      for (const existing of this.listLimits()) {
        if (!wantedLimits.has(usagePairKey(existing.providerId, existing.model))) {
          this.deleteLimitStmt.run(existing.providerId, existing.model)
        }
      }
      let inserted = 0
      for (const entry of input.limits) {
        this.upsertLimitStmt.run(
          entry.providerId, entry.model, entry.maxCalls24h, entry.maxTotalTokens24h,
          entry.switchAtPercent, input.now, input.now
        )
        inserted += 1
        if (fault !== undefined && inserted > fault.failAfterLimits) {
          throw new DatabaseError('injected usage config fault')
        }
      }
      const wantedAlternates = new Set(input.alternates.map((entry) => entry.routeKey))
      for (const existing of this.listAlternates()) {
        if (!wantedAlternates.has(existing.routeKey)) {
          this.deleteAlternateStmt.run(existing.routeKey)
        }
      }
      for (const entry of input.alternates) {
        this.upsertAlternateStmt.run(entry.routeKey, entry.providerId, entry.model, input.now, input.now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
  }

  /** Persists one deterministic Heart usage-routing decision (immutable audit). */
  insertDecision(input: {
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
    const result = this.insertDecisionStmt.run(
      input.runId, input.role, input.routeKey,
      input.baseProviderId, input.baseModel,
      input.selectedProviderId, input.selectedModel,
      input.decision, input.calls24h, input.tokens24h,
      input.tokenTelemetryComplete ? 1 : 0,
      input.maxCalls24h, input.maxTotalTokens24h, input.switchAtPercent,
      input.callsTriggered ? 1 : 0, input.tokensTriggered ? 1 : 0,
      input.snapshotAt, input.now
    )
    return toRowId(result.lastInsertRowid, 'decision id')
  }

  /** All route decisions for one run, insertion order (empty for older runs). */
  findDecisionsByRun(runId: number): StoredUsageDecision[] {
    const rows: unknown = this.findDecisionsStmt.all(runId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored usage decision rows are invalid')
    }
    return rows.map(mapDecision)
  }

  /**
   * Bounded 24-hour aggregation per provider/model. Counts every
   * reserved attempt (started/success/failed/interrupted) as an
   * outbound STARK call; token sums cover finalized successes with
   * reported totals only.
   */
  summarizeWindow(sinceMs: number): UsageAggregateRow[] {
    const rows: unknown = this.db
      .prepare(
        'SELECT provider_id, model, ' +
          'COUNT(*) AS calls, ' +
          "SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes, " +
          "SUM(CASE WHEN status = 'failed' OR status = 'interrupted' THEN 1 ELSE 0 END) AS failures, " +
          "SUM(CASE WHEN status = 'failed' AND failure_category = 'provider-rate-limit' THEN 1 ELSE 0 END) AS rate_limits, " +
          'SUM(input_tokens) AS input_tokens, ' +
          'SUM(output_tokens) AS output_tokens, ' +
          'SUM(total_tokens) AS total_tokens, ' +
          "SUM(CASE WHEN status = 'success' AND total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS successes_with_tokens " +
          'FROM ai_usage_events WHERE created_at >= ? GROUP BY provider_id, model ORDER BY MAX(created_at) DESC'
      )
      .all(sinceMs)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored usage aggregate rows are invalid')
    }
    return rows.map((row: unknown) => {
      if (!isRecord(row)) {
        throw new DatabaseError('stored usage aggregate row is invalid')
      }
      const providerId = row['provider_id']
      const model = row['model']
      const calls = row['calls']
      const successes = row['successes']
      const failures = row['failures']
      const rateLimits = row['rate_limits']
      const successesWithTokens = row['successes_with_tokens']
      if (
        typeof providerId !== 'string' ||
        typeof model !== 'string' ||
        typeof calls !== 'number' ||
        typeof successes !== 'number' ||
        typeof failures !== 'number' ||
        typeof rateLimits !== 'number' ||
        typeof successesWithTokens !== 'number'
      ) {
        throw new DatabaseError('stored usage aggregate row is invalid')
      }
      return {
        providerId,
        model,
        calls,
        successes,
        failures,
        rateLimitFailures: rateLimits,
        inputTokens: asNullableNumber(row['input_tokens'], 'aggregate row'),
        outputTokens: asNullableNumber(row['output_tokens'], 'aggregate row'),
        totalTokens: asNullableNumber(row['total_tokens'], 'aggregate row'),
        successesWithTotalTokens: successesWithTokens
      }
    })
  }

  /** One bounded startup pass: `started` leftovers become `interrupted`. */
  markStartedAsInterrupted(now: number): { interrupted: number } {
    const result = this.db
      .prepare("UPDATE ai_usage_events SET status = 'interrupted', completed_at = ? WHERE status = 'started'")
      .run(now)
    const changed = result.changes
    return { interrupted: typeof changed === 'bigint' ? Number(changed) : changed }
  }

  /** One bounded retention delete for rows older than the cutoff. */
  deleteOlderThan(cutoffMs: number): { deleted: number } {
    const result = this.db.prepare('DELETE FROM ai_usage_events WHERE created_at < ?').run(cutoffMs)
    const changed = result.changes
    return { deleted: typeof changed === 'bigint' ? Number(changed) : changed }
  }
}
