/**
 * STARK sponsored-working viewability + frequency rules.
 *
 * VIEWABILITY (V1): an impression counts only when ALL hold:
 * - sponsor actually rendered (creative != null, slot visible)
 * - document visible AND window focused
 * - continuous visible duration >= 1000ms
 *
 * If visibility/focus is lost before 1000ms, nothing counts and the
 * bounded timer resets. One bounded setTimeout per mount; no polling,
 * no intervals, no retries. Timers/listeners are cleaned up on unmount.
 *
 * FREQUENCY (V1, conservative):
 * - max one sponsor placement at a time (single slot binding)
 * - max one counted impression per AI run
 * - no remount / re-render / tab-switch / StrictMode duplicate counting
 *
 * Duration (viewableDurationMs) is collected as local telemetry for future
 * inventory analysis but never mints extra impressions.
 */

import type { AiRunId, AiRunState, MonetizationEntitlement, SponsorCreative } from './sponsor-types'
import { isGenuinelyWorking } from './sponsor-lifecycle'
import { isSponsorEligibleForEntitlement } from './sponsor-policy'

/** Continuous visible time required before one impression counts. */
export const SPONSOR_VIEWABLE_MIN_MS = 1000

export interface SponsorDisplayInputs {
  readonly entitlement: MonetizationEntitlement
  readonly aiState: AiRunState
  readonly appVisible: boolean
  readonly appFocused: boolean
  readonly creative: SponsorCreative | null
  readonly frequencyCapExceeded: boolean
}

/**
 * Full display condition:
 * eligible && !adFree && genuinelyWorking && visible && focused &&
 * creative != null && !frequencyCapExceeded.
 * Terminal/idle/streaming states never show.
 */
export function shouldShowSponsor(inputs: SponsorDisplayInputs): boolean {
  if (!isSponsorEligibleForEntitlement(inputs.entitlement)) {
    return false
  }
  if (!isGenuinelyWorking(inputs.aiState)) {
    return false
  }
  if (!inputs.appVisible || !inputs.appFocused) {
    return false
  }
  if (inputs.creative === null) {
    return false
  }
  if (inputs.frequencyCapExceeded) {
    return false
  }
  return true
}

/**
 * Pure viewability gate: counts only after >= 1000ms of continuous
 * visible+focused rendering. 999ms → false; 1000ms → true.
 */
export function isViewableAfterContinuousVisibleMs(
  appVisible: boolean,
  appFocused: boolean,
  continuousVisibleMs: number
): boolean {
  if (!appVisible || !appFocused) {
    return false
  }
  if (!Number.isFinite(continuousVisibleMs)) {
    return false
  }
  return continuousVisibleMs >= SPONSOR_VIEWABLE_MIN_MS
}

/**
 * Per-run impression ledger: at most one counted impression per AI run.
 * markCounted is idempotent — remounts, re-renders, tab switches, and
 * React StrictMode double-effects all collapse to a single impression.
 */
export interface RunImpressionLedger {
  hasCounted(runId: AiRunId): boolean
  /** Returns true when this call newly counts the run; false if already counted. */
  markCounted(runId: AiRunId): boolean
  reset(runId: AiRunId): void
}

export function createRunImpressionLedger(): RunImpressionLedger {
  const counted = new Set<AiRunId>()
  return {
    hasCounted(runId: AiRunId): boolean {
      return counted.has(runId)
    },
    markCounted(runId: AiRunId): boolean {
      if (counted.has(runId)) {
        return false
      }
      counted.add(runId)
      return true
    },
    reset(runId: AiRunId): void {
      counted.delete(runId)
    }
  }
}

/** Shared page-lifetime ledger so two slot mounts for one run still count once. */
let sharedLedger: RunImpressionLedger | null = null

export function getSharedRunImpressionLedger(): RunImpressionLedger {
  if (sharedLedger === null) {
    sharedLedger = createRunImpressionLedger()
  }
  return sharedLedger
}

/** Test seam: drops the shared ledger (tests only; never used in prod). */
export function resetSharedRunImpressionLedgerForTests(): void {
  sharedLedger = null
}

/** Injectable clock/scheduler so tests use fake timers without hangs. */
export interface ViewabilityScheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

export const realViewabilityScheduler: ViewabilityScheduler = {
  schedule(callback: () => void, delayMs: number): () => void {
    const handle = setTimeout(callback, delayMs)
    return () => {
      clearTimeout(handle)
    }
  }
}

/**
 * Bounded single-shot viewability timer. start() arms exactly one
 * timeout; cancel() disarms it. Interruptions (visibility/focus loss,
 * unmount, run end) call cancel() so nothing counts. No polling loops.
 */
export interface BoundedViewabilityTimer {
  start(): void
  cancel(): void
  readonly isArmed: boolean
}

export function createBoundedViewabilityTimer(
  onViewable: () => void,
  scheduler: ViewabilityScheduler = realViewabilityScheduler,
  delayMs: number = SPONSOR_VIEWABLE_MIN_MS
): BoundedViewabilityTimer {
  let cancelCurrent: (() => void) | null = null
  return {
    get isArmed(): boolean {
      return cancelCurrent !== null
    },
    start(): void {
      if (cancelCurrent !== null) {
        return
      }
      cancelCurrent = scheduler.schedule(() => {
        cancelCurrent = null
        onViewable()
      }, delayMs)
    },
    cancel(): void {
      if (cancelCurrent !== null) {
        cancelCurrent()
        cancelCurrent = null
      }
    }
  }
}

/**
 * Renderer-safe visibility/focus readers (no tracking beyond this).
 * Uses globalThis lookups so the module also compiles under the Node
 * test config (which has no DOM lib); in a non-DOM runtime both
 * default to true (never claim a hidden impression, never block work).
 */
interface VisibilityHolder {
  readonly visibilityState?: unknown
  readonly hasFocus?: unknown
}

export function readAppVisible(): boolean {
  try {
    const holder = globalThis as unknown as { readonly document?: VisibilityHolder }
    const state = holder.document?.visibilityState
    if (typeof state !== 'string') {
      return true
    }
    return state === 'visible'
  } catch {
    return true
  }
}

export function readAppFocused(): boolean {
  try {
    const holder = globalThis as unknown as { readonly document?: VisibilityHolder }
    const hasFocus = holder.document?.hasFocus
    if (typeof hasFocus !== 'function') {
      return true
    }
    return (hasFocus as () => boolean)()
  } catch {
    return true
  }
}
