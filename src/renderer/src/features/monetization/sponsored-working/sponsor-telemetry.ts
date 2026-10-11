/**
 * STARK sponsored-working local telemetry.
 *
 * Narrow event model with safe metadata only (opaque run id, opaque
 * creative id, placement, timestamps, durations, viewable flag). Never
 * prompt, response, code, filenames, workspace paths, terminal content,
 * attachments, keys, diffs, or tool output — enforced by the type.
 *
 * No remote upload in this pass. The sink interface can later be
 * connected to a backend. Prefer the in-memory sink in tests and the
 * no-op sink in production until a reviewed telemetry home exists.
 * No SQLite persistence (schema stays v19, no migration 020).
 */

import type { AiRunId, SponsorCreativeId, SponsorTelemetryEvent, SponsorTelemetryEventName } from './sponsor-types'

/** Narrow sink the sponsor slot reports to (later: backend connector). */
export interface SponsorTelemetrySink {
  record(event: SponsorTelemetryEvent): void
}

/** Production default: drops events (no upload, no storage). */
export class NoopSponsorTelemetrySink implements SponsorTelemetrySink {
  record(event: SponsorTelemetryEvent): void {
    void event
    // Intentionally dropped.
  }
}

/** Local test/QA sink: bounded in-memory ring for assertions. */
export class InMemorySponsorTelemetrySink implements SponsorTelemetrySink {
  private readonly events: SponsorTelemetryEvent[] = []
  private readonly capacity: number

  constructor(capacity = 64) {
    this.capacity = capacity > 0 ? capacity : 64
  }

  record(event: SponsorTelemetryEvent): void {
    this.events.push(event)
    while (this.events.length > this.capacity) {
      this.events.shift()
    }
  }

  list(): readonly SponsorTelemetryEvent[] {
    return [...this.events]
  }

  names(): readonly SponsorTelemetryEventName[] {
    return this.events.map((event) => event.name)
  }

  clear(): void {
    this.events.length = 0
  }
}

export interface SponsorTelemetryBuilderInputs {
  readonly runId: AiRunId
  readonly creativeId: SponsorCreativeId | null
  readonly at: number
  readonly viewableDurationMs: number
}

/** Builds one well-typed event; keeps call sites from inventing fields. */
export function buildSponsorTelemetryEvent(
  name: SponsorTelemetryEventName,
  inputs: SponsorTelemetryBuilderInputs,
  viewable: boolean
): SponsorTelemetryEvent {
  return {
    name,
    runId: inputs.runId,
    creativeId: inputs.creativeId,
    placement: 'ai-working',
    at: inputs.at,
    viewable,
    viewableDurationMs: Math.max(0, Math.floor(inputs.viewableDurationMs))
  }
}

export function nowMs(): number {
  return Date.now()
}
