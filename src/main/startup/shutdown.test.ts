import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_APP_SHUTDOWN_MS } from './startup-limits'
import { ORDERED_SHUTDOWN_STEPS, performOrderedShutdown, ShutdownGuard } from './shutdown'

describe('ordered bounded shutdown', () => {
  it('declares the 10s global bound and release-stable order', () => {
    assert.equal(MAX_APP_SHUTDOWN_MS, 10_000)
    assert.deepEqual([...ORDERED_SHUTDOWN_STEPS], [
      'stop-accepting-work',
      'close-preview-surfaces',
      'stop-runtime-trees',
      'terminate-terminals',
      'flush-runtime-state',
      'close-database',
      'exit'
    ])
  })

  it('runs every step in order and reports completion', () => {
    const ran: string[] = []
    const report = performOrderedShutdown(
      ORDERED_SHUTDOWN_STEPS.map((id) => ({
        id,
        run: () => {
          ran.push(id)
        }
      }))
    )
    assert.deepEqual(ran, [...ORDERED_SHUTDOWN_STEPS])
    assert.deepEqual([...report.completed], [...ORDERED_SHUTDOWN_STEPS])
    assert.equal(report.deadlineExceeded, false)
  })

  it('isolates a throwing step so later steps still run', () => {
    const ran: string[] = []
    const report = performOrderedShutdown([
      { id: 'a', run: () => { ran.push('a') } },
      { id: 'b', run: () => { throw new Error('cleanup boom') } },
      { id: 'c', run: () => { ran.push('c') } }
    ])
    assert.deepEqual(ran, ['a', 'c'])
    assert.deepEqual([...report.completed], ['a', 'c'])
  })

  it('skips remaining steps once the global deadline passes', () => {
    let now = 0
    const ran: string[] = []
    const report = performOrderedShutdown(
      [
        { id: 'a', run: () => { ran.push('a'); now += 5_000 } },
        { id: 'b', run: () => { ran.push('b'); now += 6_000 } },
        { id: 'c', run: () => { ran.push('c') } }
      ],
      { now: () => now, deadlineMs: 10_000 }
    )
    assert.ok(!ran.includes('c'))
    assert.equal(report.deadlineExceeded, true)
  })

  it('drops late child events once shutdown begins', () => {
    const guard = new ShutdownGuard()
    assert.equal(guard.isShuttingDown, false)
    let calls = 0
    assert.equal(guard.runIfActive(() => { calls += 1 }), true)
    guard.beginShutdown()
    assert.equal(guard.isShuttingDown, true)
    assert.equal(guard.runIfActive(() => { calls += 1 }), false)
    assert.equal(calls, 1)
  })
})
