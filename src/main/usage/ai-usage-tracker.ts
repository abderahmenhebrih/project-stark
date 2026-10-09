/**
 * Central outbound provider-call tracker (Stage 28).
 *
 * EVERY outbound AI adapter invocation in STARK passes through
 * `track` — Ask, Brain plan, Worker turns, synthesis, single/multi
 * proposals, and all Recovery variants. Reserve-before-call
 * (`started`), invoke exactly once, then finalize with reported
 * usage or a safe failure category. Telemetry failures never cause
 * another provider call and never convert success into retry: the
 * original provider result/error always wins. Zero added provider
 * calls, no polling, no retries, no loops.
 */

import type { AiUsageRepository } from './ai-usage-repository'
import type { AiUsageService } from './ai-usage-service'
import type { ProviderUsage } from './ai-usage-types'

/**
 * Optional usage-awareness dependencies for AI services. Existing
 * harnesses omit the whole object and keep legacy untracked
 * behavior; production always wires a real tracker + service.
 */
export interface AiUsageDeps {
  readonly tracker: AiUsageTracker
  readonly service: AiUsageService
}
import {
  ProviderForbiddenError,
  ProviderInvalidCredentialError,
  ProviderCredentialMissingError,
  ProviderModelUnavailableError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderStructuredOutputUnsupportedError,
  ProviderTimeoutError
} from '../ai/errors'

/** Main-owned tracking metadata for one outbound provider attempt. */
export interface TrackCallMeta {
  readonly operation: string
  readonly role: 'ask' | 'brain' | 'worker' | 'proposal' | 'recovery'
  readonly providerId: string
  readonly model: string
  readonly workspaceId: number | null
  readonly sessionId: number | null
  readonly runId: number | null
}

/**
 * Maps a thrown invocation failure to a safe stored category.
 * Only error type names are inspected — never payloads or secrets.
 */
export function failureCategoryOf(error: unknown): string {
  if (error instanceof ProviderRateLimitedError) {
    return 'provider-rate-limit'
  }
  if (error instanceof ProviderTimeoutError) {
    return 'provider-timeout'
  }
  if (error instanceof ProviderNetworkError) {
    return 'provider-network'
  }
  if (error instanceof ProviderModelUnavailableError || error instanceof ProviderStructuredOutputUnsupportedError) {
    return 'model-unavailable'
  }
  if (error instanceof ProviderInvalidCredentialError || error instanceof ProviderCredentialMissingError) {
    return 'credential'
  }
  if (error instanceof ProviderForbiddenError) {
    return 'permission'
  }
  return 'other-safe-category'
}

/** Extracts normalized usage from an adapter result carrying `usage?`. */
export function usageOfResult(result: unknown): ProviderUsage {
  if (typeof result !== 'object' || result === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null }
  }
  const usage = (result as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null }
  }
  const record = usage as Record<string, unknown>
  const pick = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  return {
    inputTokens: pick(record['inputTokens']),
    outputTokens: pick(record['outputTokens']),
    totalTokens: pick(record['totalTokens'])
  }
}

export class AiUsageTracker {
  private readonly now: () => number

  constructor(
    private readonly events: AiUsageRepository,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /**
   * Tracks one outbound provider invocation: reserve `started`,
   * invoke EXACTLY once, finalize success (reported usage) or
   * failure (safe category), then return/rethrow the original.
   * Reserve/finalize failures are swallowed — telemetry is
   * observability and must never duplicate model operations.
   */
  async track<T>(meta: TrackCallMeta, invoke: () => Promise<T>): Promise<T> {
    const startedAt = this.now()
    const eventId = this.tryReserve(meta, startedAt)
    try {
      const result = await invoke()
      if (eventId !== null) {
        try {
          const usage = usageOfResult(result)
          this.events.finalizeSuccess(eventId, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            latencyMs: Math.max(0, this.now() - startedAt),
            now: this.now()
          })
        } catch {
          // Telemetry must never rewrite a successful result.
        }
      }
      return result
    } catch (error) {
      if (eventId !== null) {
        try {
          this.events.finalizeFailure(eventId, {
            failureCategory: failureCategoryOf(error),
            latencyMs: Math.max(0, this.now() - startedAt),
            now: this.now()
          })
        } catch {
          // The original provider error always wins.
        }
      }
      throw error
    }
  }

  /** Best-effort reservation: DB failure yields null, never a throw. */
  private tryReserve(meta: TrackCallMeta, startedAt: number): number | null {
    try {
      return this.events
        .reserveEvent({
          providerId: meta.providerId,
          model: meta.model,
          operation: meta.operation,
          role: meta.role,
          workspaceId: meta.workspaceId,
          sessionId: meta.sessionId,
          runId: meta.runId,
          now: startedAt
        })
        .id
    } catch {
      return null
    }
  }
}
