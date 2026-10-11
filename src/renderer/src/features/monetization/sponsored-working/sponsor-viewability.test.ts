import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createBoundedViewabilityTimer,
  createRunImpressionLedger,
  isViewableAfterContinuousVisibleMs,
  shouldShowSponsor,
  SPONSOR_VIEWABLE_MIN_MS,
  type ViewabilityScheduler
} from './sponsor-viewability'
import { DevFixtureSponsorProvider, buildSponsorContext } from './sponsor-provider'
import { entitlementForPlan } from './sponsor-policy'

/** Manual fake timer: deterministic, bounded, no real waiting. */
function createManualScheduler(): ViewabilityScheduler & { fire(): number; pending(): number } {
  const queue: Array<() => void> = []
  return {
    schedule(callback: () => void, delayMs: number): () => void {
      void delayMs
      queue.push(callback)
      let cancelled = false
      return () => {
        if (!cancelled) {
          cancelled = true
          const index = queue.indexOf(callback)
          if (index >= 0) {
            queue.splice(index, 1)
          }
        }
      }
    },
    fire(): number {
      const pending = [...queue]
      queue.length = 0
      for (const callback of pending) {
        callback()
      }
      return pending.length
    },
    pending(): number {
      return queue.length
    }
  }
}

const FREE = entitlementForPlan('free')
const CREATIVE = new DevFixtureSponsorProvider().getCreative(buildSponsorContext())

describe('sponsor viewability (fake timers)', () => {
  it('requires a 1000ms continuous visible threshold', () => {
    assert.equal(SPONSOR_VIEWABLE_MIN_MS, 1000)
    assert.equal(isViewableAfterContinuousVisibleMs(true, true, 999), false)
    assert.equal(isViewableAfterContinuousVisibleMs(true, true, 1000), true)
    assert.equal(isViewableAfterContinuousVisibleMs(true, true, 5000), true)
  })

  it('999ms visible does not count; 1000ms continuous counts once', () => {
    assert.equal(isViewableAfterContinuousVisibleMs(true, true, 999), false)
    const ledger = createRunImpressionLedger()
    const scheduler = createManualScheduler()
    let counted = 0
    const timer = createBoundedViewabilityTimer(() => {
      if (ledger.markCounted('run-1')) {
        counted += 1
      }
    }, scheduler)
    timer.start()
    // 999ms equivalent: interruption cancels before firing.
    timer.cancel()
    assert.equal(scheduler.fire(), 0)
    assert.equal(counted, 0)
    // 1000ms equivalent: timer fires once.
    timer.start()
    assert.equal(scheduler.pending(), 1)
    assert.equal(scheduler.fire(), 1)
    assert.equal(counted, 1)
  })

  it('visibility interruption resets the timer (no false impression)', () => {
    const scheduler = createManualScheduler()
    let counted = 0
    const timer = createBoundedViewabilityTimer(() => {
      counted += 1
    }, scheduler)
    timer.start()
    assert.equal(timer.isArmed, true)
    // App hidden before 1000ms: cancel like the component does.
    timer.cancel()
    assert.equal(timer.isArmed, false)
    assert.equal(scheduler.fire(), 0)
    assert.equal(counted, 0)
    // Blur also prevents counting at the gate level.
    assert.equal(isViewableAfterContinuousVisibleMs(true, false, 1000), false)
    assert.equal(isViewableAfterContinuousVisibleMs(false, true, 1000), false)
  })

  it('StrictMode/remount counts at most one impression per run', () => {
    const ledger = createRunImpressionLedger()
    // Two mounts (StrictMode double-effect) race to mark the same run.
    assert.equal(ledger.markCounted('run-strict'), true)
    assert.equal(ledger.markCounted('run-strict'), false)
    assert.equal(ledger.hasCounted('run-strict'), true)
  })

  it('switching tabs/windows does not duplicate the run impression', () => {
    const ledger = createRunImpressionLedger()
    const scheduler = createManualScheduler()
    let counted = 0
    const onViewable = (): void => {
      if (ledger.markCounted('run-tab')) {
        counted += 1
      }
    }
    const first = createBoundedViewabilityTimer(onViewable, scheduler)
    const second = createBoundedViewabilityTimer(onViewable, scheduler)
    first.start()
    second.start()
    scheduler.fire()
    assert.equal(counted, 1)
  })

  it('frequency cap hides the slot after one counted impression', () => {
    assert.equal(
      shouldShowSponsor({
        entitlement: FREE,
        aiState: 'working',
        appVisible: true,
        appFocused: true,
        creative: CREATIVE,
        frequencyCapExceeded: false
      }),
      true
    )
    assert.equal(
      shouldShowSponsor({
        entitlement: FREE,
        aiState: 'working',
        appVisible: true,
        appFocused: true,
        creative: CREATIVE,
        frequencyCapExceeded: true
      }),
      false
    )
  })

  it('no remount/re-render duplicate counting via idempotent ledger', () => {
    const ledger = createRunImpressionLedger()
    let events = 0
    for (let index = 0; index < 5; index += 1) {
      if (ledger.markCounted('run-rerender')) {
        events += 1
      }
    }
    assert.equal(events, 1)
  })

  it('timer is bounded: single shot, no polling or repeat', () => {
    const scheduler = createManualScheduler()
    let calls = 0
    const timer = createBoundedViewabilityTimer(() => {
      calls += 1
    }, scheduler)
    timer.start()
    timer.start() // second start is a no-op while armed
    assert.equal(scheduler.pending(), 1)
    scheduler.fire()
    assert.equal(calls, 1)
    assert.equal(scheduler.pending(), 0)
  })
})
