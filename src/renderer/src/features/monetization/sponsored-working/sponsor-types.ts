/**
 * STARK sponsored-working shared types (Free-tier monetization foundation).
 *
 * Plain structured data only. No HTML, no scripts, no iframes, no pixels,
 * no network, no Node.js or DOM APIs. This module is importable from both
 * the renderer (web tsconfig) and the Node test runner.
 *
 * PRODUCT RULE (locked):
 * - Free may show a clearly labeled sponsor while STARK is genuinely working.
 * - Sponsorship disappears when work finishes.
 * - Sponsored content is NEVER inserted into AI output.
 * - Magma / Frost / funded Void are ad-free.
 * - Only genuine work time is monetized; no artificial waits.
 */

/** Opaque AI-run correlation key shared by Brain / Heart legs of one user run. */
export type AiRunId = string

/** Opaque creative identifier (never a URL, never executable content). */
export type SponsorCreativeId = string

/**
 * Sponsor-observable AI activity states.
 *
 * The upcoming Brain/Heart runtime drives these; the sponsor system only
 * observes them and never controls them. Mapped from current SessionPanel
 * truth in sponsor-lifecycle.ts (no runtime rewrite to manufacture states).
 */
export type AiRunState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'working'
  | 'tool-running'
  | 'waiting-provider'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Minimal safe sponsor creative: trusted structured text only. */
export interface SponsorCreative {
  readonly id: SponsorCreativeId
  readonly sponsorName: string
  readonly message: string
  /** Always rendered verbatim next to the sponsor name (e.g. "Sponsored"). */
  readonly disclosureLabel: string
}

/**
 * Explicit whitelist for sponsor selection context.
 *
 * This is the ONLY data a SponsorProvider may ever receive. Any field not
 * listed here (prompt, response, code, filenames, workspace paths, terminal
 * contents, attachments, keys, diffs, tool output, model context) is a
 * privacy violation by construction: the type cannot carry it.
 */
export interface SponsorPlacementContext {
  readonly placement: 'ai-working'
}

/** Narrow monetization entitlement derived from the account plan. */
export interface MonetizationEntitlement {
  readonly sponsoredWorkingEligible: boolean
  readonly adFree: boolean
}

/**
 * STARK account plans relevant to monetization.
 *
 * Billing backend is future work; this union is the local policy seam.
 * - 'free': sponsored working eligible, not ad-free.
 * - 'magma' | 'frost' | 'void': paid/funded, ad-free.
 * - 'void-unfunded': not yet funded; treated as Free until funding lands.
 */
export type StarkAccountPlan = 'free' | 'magma' | 'frost' | 'void' | 'void-funded' | 'void-unfunded'

/** Future economics seam: sponsor revenue for one run (micros of currency). */
export interface SponsorEconomics {
  readonly revenueMicros?: number
}

/** Future economics seam: actual inference COGS for one run (micros). */
export interface InferenceEconomics {
  readonly actualCostMicros?: number
}

/** Narrow telemetry event names for the sponsored-working slot. */
export type SponsorTelemetryEventName =
  | 'sponsor_requested'
  | 'sponsor_rendered'
  | 'sponsor_viewable'
  | 'sponsor_hidden'

/**
 * Safe telemetry payload. Only opaque ids, placement, timestamps, and
 * durations. Never prompt, response, code, filenames, workspace paths,
 * terminal content, attachments, or keys.
 */
export interface SponsorTelemetryEvent {
  readonly name: SponsorTelemetryEventName
  readonly runId: AiRunId
  readonly creativeId: SponsorCreativeId | null
  readonly placement: SponsorPlacementContext['placement']
  readonly at: number
  readonly viewable: boolean
  readonly viewableDurationMs: number
}
