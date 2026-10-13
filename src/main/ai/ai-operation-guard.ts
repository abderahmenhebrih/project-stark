import { AiCancelledError, GenerationInFlightError } from './errors'

/**
 * Shared per-session AI operation guard (Stage 14, generalized in
 * Stage 16): at most one AI operation — normal assistant generation
 * OR code-proposal generation — may be active for a given session.
 * No queue, no retry. Callers acquire before work and release in a
 * finally block so locks clear on success and on every failure.
 *
 * User cancellation is scoped to the session's ACTIVE operation only
 * (never a global kill): requestCancel records the request plus
 * aborts the operation's signal, runners observe it between phases
 * and inside LoopLink failover, and release clears everything so
 * the session is immediately reusable. Cancelling an idle session
 * is a harmless false — never an error, never stored.
 */
export class AiOperationGuard {
  private readonly active = new Set<number>()
  private readonly cancelled = new Set<number>()
  private readonly controllers = new Map<number, AbortController>()

  /** Acquires the session slot or throws `GenerationInFlightError`. */
  acquire(sessionId: number): void {
    if (this.active.has(sessionId)) {
      throw new GenerationInFlightError()
    }
    this.active.add(sessionId)
    this.cancelled.delete(sessionId)
    this.controllers.set(sessionId, new AbortController())
  }

  /** Releases the session slot and its cancel state. Idempotent. */
  release(sessionId: number): void {
    this.active.delete(sessionId)
    this.cancelled.delete(sessionId)
    this.controllers.delete(sessionId)
  }

  /** Test/observation hook: whether a session currently holds the slot. */
  isActive(sessionId: number): boolean {
    return this.active.has(sessionId)
  }

  /**
   * Records user cancellation for the session's active operation and
   * aborts its signal. Returns true when an operation was active
   * (cancel recorded); false when idle — a harmless no-op that
   * stores nothing, so duplicate cancels are idempotent.
   */
  requestCancel(sessionId: number): boolean {
    if (!this.active.has(sessionId)) {
      return false
    }
    this.cancelled.add(sessionId)
    this.controllers.get(sessionId)?.abort()
    return true
  }

  /** True when cancellation was requested for the ACTIVE operation. */
  isCancelRequested(sessionId: number): boolean {
    return this.active.has(sessionId) && this.cancelled.has(sessionId)
  }

  /**
   * Throws AiCancelledError when the session's active operation was
   * cancelled. Call at loop tops alongside requireDeadline so
   * cancellation surfaces as cancel (user-initiated), never as a
   * timeout or a plan-shape error. No-op when idle or uncancelled.
   */
  throwIfCancelled(sessionId: number): void {
    if (this.isCancelRequested(sessionId)) {
      throw new AiCancelledError()
    }
  }

  /**
   * AbortSignal for the session's active operation, or null when
   * idle. Adapters combine it with their own bounded timeouts —
   * cancellation aborts in-flight provider calls without changing
   * timeout semantics (timeout stays timeout, cancel stays cancel).
   */
  signalFor(sessionId: number): AbortSignal | null {
    if (!this.active.has(sessionId)) {
      return null
    }
    const controller = this.controllers.get(sessionId)
    if (controller === undefined) {
      return null
    }
    return controller.signal
  }

  /**
   * Spread-ready cancellation option for one adapter request:
   * `...guard.signalOptionFor(sessionId)`. Empty when idle so
   * unwired/legacy paths keep working with timeouts only.
   */
  signalOptionFor(sessionId: number): { readonly signal?: AbortSignal } {
    const signal = this.signalFor(sessionId)
    return signal === null ? {} : { signal }
  }
}
