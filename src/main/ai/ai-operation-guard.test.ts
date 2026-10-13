import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AiOperationGuard } from './ai-operation-guard'
import { GenerationInFlightError } from './errors'

/**
 * Operation-guard cancellation proof: user cancellation is scoped
 * to the session's ACTIVE operation only, idempotent when idle or
 * duplicated, and fully cleared on release so the session is
 * immediately reusable. No global state, no leaks.
 */
describe('ai operation guard cancellation', () => {
  it('acquire/release preserve the single-flight invariant', () => {
    const guard = new AiOperationGuard()
    assert.equal(guard.isActive(7), false)
    guard.acquire(7)
    assert.equal(guard.isActive(7), true)
    assert.throws(() => guard.acquire(7), GenerationInFlightError)
    guard.release(7)
    assert.equal(guard.isActive(7), false)
    guard.release(7)
  })

  it('cancel on an idle session is a harmless false that stores nothing', () => {
    const guard = new AiOperationGuard()
    assert.equal(guard.requestCancel(9), false)
    assert.equal(guard.isCancelRequested(9), false)
    assert.equal(guard.signalFor(9), null)
    // A later acquire starts clean (no stale cancel observed).
    guard.acquire(9)
    assert.equal(guard.isCancelRequested(9), false)
    guard.release(9)
  })

  it('cancel on an active session records, aborts the signal, and stays idempotent', () => {
    const guard = new AiOperationGuard()
    guard.acquire(11)
    const before = guard.signalFor(11)
    assert.ok(before instanceof AbortSignal)
    assert.equal(before.aborted, false)
    assert.equal(guard.requestCancel(11), true)
    assert.equal(guard.isCancelRequested(11), true)
    assert.equal(before.aborted, true)
    assert.equal(guard.signalFor(11), before)
    // Duplicate cancels are harmless and stay recorded.
    assert.equal(guard.requestCancel(11), true)
    assert.equal(guard.isCancelRequested(11), true)
  })

  it('release clears cancel state so the session is immediately reusable', () => {
    const guard = new AiOperationGuard()
    guard.acquire(13)
    assert.equal(guard.requestCancel(13), true)
    guard.release(13)
    assert.equal(guard.isActive(13), false)
    assert.equal(guard.isCancelRequested(13), false)
    assert.equal(guard.signalFor(13), null)
    guard.acquire(13)
    assert.equal(guard.isCancelRequested(13), false)
    assert.equal(guard.signalFor(13)?.aborted, false)
    guard.release(13)
  })

  it('cancellation is scoped per session (never global)', () => {
    const guard = new AiOperationGuard()
    guard.acquire(21)
    guard.acquire(22)
    assert.equal(guard.requestCancel(21), true)
    assert.equal(guard.isCancelRequested(21), true)
    assert.equal(guard.isCancelRequested(22), false)
    assert.equal(guard.signalFor(22)?.aborted, false)
    guard.release(21)
    guard.release(22)
  })

  it('throwIfCancelled surfaces cancel only for the active operation', () => {
    const guard = new AiOperationGuard()
    guard.throwIfCancelled(31)
    guard.acquire(31)
    guard.throwIfCancelled(31)
    guard.requestCancel(31)
    assert.throws(() => guard.throwIfCancelled(31), (error: unknown) => {
      return error instanceof Error && error.message === 'The AI operation was cancelled.'
    })
    guard.release(31)
    guard.throwIfCancelled(31)
  })

  it('signalOptionFor spreads empty when idle and the signal when active', () => {
    const guard = new AiOperationGuard()
    assert.deepEqual(guard.signalOptionFor(41), {})
    guard.acquire(41)
    const option = guard.signalOptionFor(41)
    assert.ok(option.signal instanceof AbortSignal)
    guard.release(41)
  })
})
