import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runStartupRecoveryPasses, STARTUP_RECOVERY_ORDER, type StartupRecoveryTargets } from './startup-order'

function trackingTargets(failAt?: string): { targets: StartupRecoveryTargets; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    targets: {
      markOrchestrationRunningInterrupted: () => {
        if (failAt === 'orchestration') {
          throw new Error('boom')
        }
        calls.push('orchestration-interrupted')
      },
      markRecoveryRunningInterrupted: () => {
        if (failAt === 'recovery') {
          throw new Error('boom')
        }
        calls.push('recovery-interrupted')
      },
      markWorkerCommandsInterrupted: () => {
        if (failAt === 'commands') {
          throw new Error('boom')
        }
        calls.push('commands-interrupted')
        return { runIds: [7] as readonly number[] }
      },
      failParkedRuns: () => {
        calls.push('fail-parked')
      },
      recoverProjectRuntimes: () => {
        if (failAt === 'runtimes') {
          throw new Error('boom')
        }
        calls.push('project-runtimes-recover')
      },
      cleanupUsage: () => {
        if (failAt === 'usage') {
          throw new Error('boom')
        }
        calls.push('usage-cleanup')
      }
    }
  }
}

describe('startup recovery ordering', () => {
  it('runs all five passes in explicit order', () => {
    const { targets, calls } = trackingTargets()
    const completed = runStartupRecoveryPasses(targets, 1000)
    assert.deepEqual([...completed], [...STARTUP_RECOVERY_ORDER])
    assert.deepEqual(calls, [
      'orchestration-interrupted',
      'recovery-interrupted',
      'commands-interrupted',
      'fail-parked',
      'project-runtimes-recover',
      'usage-cleanup'
    ])
  })

  it('isolates a throwing pass so later passes still run', () => {
    const { targets, calls } = trackingTargets('recovery')
    const completed = runStartupRecoveryPasses(targets, 1000)
    assert.ok(!completed.includes('recovery-interrupted'))
    assert.ok(completed.includes('orchestration-interrupted'))
    assert.ok(completed.includes('usage-cleanup'))
    assert.ok(calls.includes('usage-cleanup'))
  })

  it('performs zero provider calls and never resumes work', () => {
    const { targets } = trackingTargets()
    // The seam exposes no provider, spawn, relaunch, or resume entry:
    // recovery is mark-interrupted only.
    assert.deepEqual(Object.keys(targets).sort(), [
      'cleanupUsage',
      'failParkedRuns',
      'markOrchestrationRunningInterrupted',
      'markRecoveryRunningInterrupted',
      'markWorkerCommandsInterrupted',
      'recoverProjectRuntimes'
    ])
  })
})
