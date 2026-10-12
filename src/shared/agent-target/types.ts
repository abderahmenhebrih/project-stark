/**
 * Shared agent-target + STARK effort contracts (composer hardening).
 *
 * Plain TypeScript only — no Node.js or DOM APIs. Importable from
 * main, preload, renderer, and the Node test runner.
 *
 * - AgentTarget: which agent the composer sends to. STARK is local;
 *   external adapters (Kilo first) run through a typed registry and
 *   must enter the existing Change Transaction / Review flow.
 * - StarkEffort: speed-vs-quality selector for STARK only. External
 *   targets never consume it ("Managed by Kilo").
 */

/** Speed-vs-quality selector for STARK runs. */
export type StarkEffort = 'light' | 'regular' | 'medium' | 'high' | 'xhigh'

/** Exact five levels in ascending strength order. */
export const STARK_EFFORTS: readonly StarkEffort[] = ['light', 'regular', 'medium', 'high', 'xhigh']

/** Default effort: reproduces the current STARK runtime baseline. */
export const DEFAULT_STARK_EFFORT: StarkEffort = 'regular'

/** Compact menu labels (visible copy). */
export const STARK_EFFORT_LABELS: Record<StarkEffort, string> = {
  light: 'Light',
  regular: 'Regular',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh'
}

/** Concise tooltips (menu copy). */
export const STARK_EFFORT_TOOLTIPS: Record<StarkEffort, string> = {
  light: 'Fastest',
  regular: 'Balanced',
  medium: 'More reasoning',
  high: 'Deeper reasoning',
  xhigh: 'Maximum quality'
}

/** True for exactly the five known effort ids. */
export function isStarkEffort(value: unknown): value is StarkEffort {
  return (
    value === 'light' ||
    value === 'regular' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}

/** Sanitizes an unknown persisted value back to a valid effort. */
export function normalizeStarkEffort(value: unknown): StarkEffort {
  return isStarkEffort(value) ? value : DEFAULT_STARK_EFFORT
}

/** Which agent the composer sends to. */
export type AgentTarget = { readonly kind: 'stark' } | { readonly kind: 'external'; readonly adapterId: string }

/** First (and currently only) external adapter id. */
export const KILO_ADAPTER_ID = 'kilo-code' as const

/** Display name for the Kilo external coding agent. */
export const KILO_DISPLAY_NAME = 'Kilo Code' as const

/** Default composer target: STARK. */
export const DEFAULT_AGENT_TARGET: AgentTarget = { kind: 'stark' }

/** True when the target routes to STARK (effort applies). */
export function isStarkTarget(target: AgentTarget): boolean {
  return target.kind === 'stark'
}

/**
 * Honest Kilo availability states. The selector disables Kilo unless
 * status is 'available' or 'running'; 'unavailable' carries a concise
 * human reason (never a fake working state).
 */
export type KiloAvailabilityStatus = 'available' | 'unavailable' | 'connecting' | 'running' | 'error'

export interface KiloAvailability {
  readonly status: KiloAvailabilityStatus
  /** Concise human reason when not available (e.g. "Kilo bridge not available"). */
  readonly reason: string | null
  /** Detected backend version when known (display only, never a secret). */
  readonly version: string | null
}

/** Sanitized Kilo availability for the renderer (no tokens, env, or URLs). */
export function emptyKiloUnavailable(reason: string): KiloAvailability {
  return { status: 'unavailable', reason, version: null }
}

/**
 * Internal STARK send-mode overrides. The primary composer selector no
 * longer exposes Ask / Work / Propose — normal STARK sends use the
 * unified Work path — but the three runtime paths remain for explicit
 * `/ask`, `/work`, `/propose` slash overrides.
 */
export type StarkSendMode = 'ask' | 'work' | 'propose'

/**
 * Smallest local slash parser for the three explicit overrides.
 * Returns the override mode plus the message with the prefix stripped,
 * or null when the input carries no override prefix. Case-insensitive,
 * leading-whitespace tolerant, prefix-only (`/ask …`, `/work …`,
 * `/propose …`, `/propose-change …`). A bare `/ask` with no body is
 * not an override (avoids hijacking a lone slash).
 */
export function parseStarkSlashOverride(input: string): { readonly mode: StarkSendMode; readonly content: string } | null {
  const trimmedStart = input.replace(/^\s+/, '')
  const match = /^\/([A-Za-z][A-Za-z-]*)(?:\s+([\s\S]*))?$/.exec(trimmedStart)
  if (match === null) {
    return null
  }
  const head = (match[1] ?? '').toLowerCase()
  const body = (match[2] ?? '').trim()
  if (body === '') {
    return null
  }
  if (head === 'ask') {
    return { mode: 'ask', content: body }
  }
  if (head === 'work') {
    return { mode: 'work', content: body }
  }
  if (head === 'propose' || head === 'propose-change' || head === 'proposechange') {
    return { mode: 'propose', content: body }
  }
  return null
}

/**
 * Deterministic internal resolver for STARK sends: explicit slash
 * overrides win, otherwise the unified Work path handles both
 * questions and coding tasks (Brain answers directly when no tools
 * are needed). No classifier model, no heuristics.
 */
export function resolveStarkSendMode(input: string): { readonly mode: StarkSendMode; readonly content: string } {
  const override = parseStarkSlashOverride(input)
  if (override !== null) {
    return override
  }
  return { mode: 'work', content: input }
}
