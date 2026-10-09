import { MAX_APP_SHUTDOWN_MS, SHUTDOWN_ORDER } from './startup-limits'

/**
 * Ordered, bounded application shutdown (Stage 30).
 *
 * High-level order: stop accepting work → close Preview/inspection
 * surfaces → stop exact runtime trees → terminate terminals → flush
 * runtime state → close database → exit. Every step is best-effort;
 * the global deadline caps total cleanup at MAX_APP_SHUTDOWN_MS with
 * no infinite waits and no broad process kills.
 */

/** One named shutdown step. Synchronous and best-effort by contract. */
export interface ShutdownStep {
  readonly id: string
  run(): void
}

/** Shutdown report: which steps ran and whether the deadline hit. */
export interface ShutdownReport {
  readonly completed: readonly string[]
  readonly deadlineExceeded: boolean
}

/**
 * Process-lifetime shutdown guard. Once begun, late child events must
 * be dropped instead of writing after the database closes.
 */
export class ShutdownGuard {
  private shuttingDown = false

  /** Marks shutdown start; late events drop from here on. */
  beginShutdown(): void {
    this.shuttingDown = true
  }

  /** True once shutdown has begun (late events must drop). */
  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /** Runs the callback only while shutdown has NOT begun. */
  runIfActive(callback: () => void): boolean {
    if (this.shuttingDown) {
      return false
    }
    callback()
    return true
  }
}

/**
 * Runs the ordered shutdown steps within the global deadline. Steps
 * are expected in SHUTDOWN_ORDER; unknown ids still run in given
 * order. A step that throws never prevents later steps. When the
 * deadline passes, remaining steps are skipped best-effort.
 */
export function performOrderedShutdown(
  steps: readonly ShutdownStep[],
  options?: { now?: () => number; deadlineMs?: number }
): ShutdownReport {
  const now = options?.now ?? Date.now
  const deadlineMs = options?.deadlineMs ?? MAX_APP_SHUTDOWN_MS
  const startedAt = now()
  const completed: string[] = []
  for (const step of steps) {
    if (now() - startedAt > deadlineMs) {
      return { completed, deadlineExceeded: true }
    }
    try {
      step.run()
      completed.push(step.id)
    } catch {
      // Best effort: one failing step never blocks the rest.
    }
  }
  return { completed, deadlineExceeded: now() - startedAt > deadlineMs }
}

/** The release-stable shutdown step order (re-exported for wiring/tests). */
export const ORDERED_SHUTDOWN_STEPS: readonly string[] = SHUTDOWN_ORDER
