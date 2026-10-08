import { GenerationInFlightError } from './errors'

/**
 * Shared per-session AI operation guard (Stage 14, generalized in
 * Stage 16): at most one AI operation — normal assistant generation
 * OR code-proposal generation — may be active for a given session.
 * No queue, no retry. Callers acquire before work and release in a
 * finally block so locks clear on success and on every failure.
 */
export class AiOperationGuard {
  private readonly active = new Set<number>()

  /** Acquires the session slot or throws `GenerationInFlightError`. */
  acquire(sessionId: number): void {
    if (this.active.has(sessionId)) {
      throw new GenerationInFlightError()
    }
    this.active.add(sessionId)
  }

  /** Releases the session slot. Idempotent. */
  release(sessionId: number): void {
    this.active.delete(sessionId)
  }

  /** Test/observation hook: whether a session currently holds the slot. */
  isActive(sessionId: number): boolean {
    return this.active.has(sessionId)
  }
}
