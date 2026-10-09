/**
 * Explicit startup recovery ordering (Stage 30).
 *
 * The five bounded startup recovery passes from src/main/index.ts as
 * one ordered, testable unit. Every pass is best-effort, side-effect
 * free beyond marking stale rows interrupted, and performs zero
 * provider calls, zero retries, zero relaunches.
 */

export interface StartupRecoveryTargets {
  markOrchestrationRunningInterrupted(now: number): void
  markRecoveryRunningInterrupted(now: number): void
  markWorkerCommandsInterrupted(now: number): { runIds: readonly number[] }
  failParkedRuns(runIds: readonly number[], now: number): void
  recoverProjectRuntimes(now: number): void
  cleanupUsage(now: number): void
}

/** Ordered recovery pass ids, matching execution order below. */
export const STARTUP_RECOVERY_ORDER: readonly string[] = [
  'orchestration-interrupted',
  'recovery-interrupted',
  'worker-commands-interrupted',
  'project-runtimes-recover',
  'usage-cleanup'
]

/**
 * Runs every startup recovery pass in order. Each pass is isolated:
 * a throwing pass never prevents later passes, and nothing here
 * resumes, retries, relaunches, or kills.
 */
export function runStartupRecoveryPasses(targets: StartupRecoveryTargets, now: number): readonly string[] {
  const completed: string[] = []
  try {
    targets.markOrchestrationRunningInterrupted(now)
    completed.push('orchestration-interrupted')
  } catch {
    // Best effort: a failed mark must never block startup.
  }
  try {
    targets.markRecoveryRunningInterrupted(now)
    completed.push('recovery-interrupted')
  } catch {
    // Best effort.
  }
  try {
    const outcome = targets.markWorkerCommandsInterrupted(now)
    try {
      targets.failParkedRuns(outcome.runIds, now)
    } catch {
      // Best effort per run.
    }
    completed.push('worker-commands-interrupted')
  } catch {
    // Best effort.
  }
  try {
    targets.recoverProjectRuntimes(now)
    completed.push('project-runtimes-recover')
  } catch {
    // Best effort.
  }
  try {
    targets.cleanupUsage(now)
    completed.push('usage-cleanup')
  } catch {
    // Best effort.
  }
  return completed
}
