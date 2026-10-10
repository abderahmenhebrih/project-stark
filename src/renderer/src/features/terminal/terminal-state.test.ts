import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { confirmCloseTerminalAndSwitch, hasActiveTerminal, setTerminalActive, TERMINAL_SWITCH_CONFIRM_MESSAGE } from './terminal-guard'
import {
  canCreateTerminal,
  clampTerminalDimensions,
  initialTerminalSessionsState,
  MAX_HUMAN_TERMINALS,
  nextTerminalTitle,
  routeTerminalDataToSession,
  TERMINAL_LIMIT_NOTICE,
  terminalSessionsReducer,
  type TerminalSessionsState,
  visibleTerminalIds
} from './terminal-state'

/**
 * Multi-terminal renderer logic: empty initial state (no auto-start),
 * explicit per-terminal start/running/exit/removal, deterministic
 * titles, active selection, split visibility, the human cap with no
 * eviction, stale-session filtering, workspace reset, bounded resize
 * dims, and the workspace-switch guard. No xterm or IPC here — pure
 * transitions.
 */

function bound(): TerminalSessionsState {
  return { ...initialTerminalSessionsState(), workspaceId: 9 }
}

function session(id: string, shell = 'PowerShell') {
  return { id, workspaceId: 9, shell, running: true }
}

function start(state: TerminalSessionsState, key: string, id: string, shell = 'PowerShell', title = ''): TerminalSessionsState {
  const requesting = terminalSessionsReducer(state, { type: 'start-requested', key })
  return terminalSessionsReducer(requesting, { type: 'start-succeeded', key, session: session(id, shell), title })
}

describe('terminal sessions state', () => {
  it('starts empty with no session (no auto-spawn)', () => {
    const state = bound()
    assert.deepEqual(state.sessions, [])
    assert.deepEqual(state.pending, [])
    assert.equal(state.activeId, null)
    assert.equal(state.splitIds, null)
    assert.deepEqual(visibleTerminalIds(state), [])
    assert.equal(state.notice, null)
  })

  it('runs the explicit start flow and selects the new terminal', () => {
    const requesting = terminalSessionsReducer(bound(), { type: 'start-requested', key: 'k1' })
    assert.deepEqual(requesting.pending, [{ key: 'k1' }])
    const running = terminalSessionsReducer(requesting, {
      type: 'start-succeeded',
      key: 'k1',
      session: session('11111111-1111-4111-8111-111111111111'),
      title: ''
    })
    assert.equal(running.sessions.length, 1)
    assert.equal(running.sessions[0]?.status, 'running')
    assert.equal(running.sessions[0]?.title, 'PowerShell')
    assert.equal(running.activeId, '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(visibleTerminalIds(running), ['11111111-1111-4111-8111-111111111111'])
    assert.deepEqual(running.pending, [])
  })

  it('normal multi-terminal shows exactly one canvas per start', () => {
    // A → only A; B → only B; C → only C. Sessions accumulate, but
    // no start, select, or duplicate ever produces a visible pair —
    // only an explicit Split does.
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const idC = '33333333-3333-4333-8333-333333333333'
    let state = start(bound(), 'k1', idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.equal(state.splitIds, null)
    state = start(state, 'k2', idB)
    assert.deepEqual(visibleTerminalIds(state), [idB])
    assert.equal(state.splitIds, null)
    state = start(state, 'k3', idC)
    assert.deepEqual(visibleTerminalIds(state), [idC])
    assert.equal(state.splitIds, null)
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA, idB, idC]
    )
  })

  it('second start keeps the first terminal alive with a unique title', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = start(state, 'k2', '22222222-2222-4222-8222-222222222222')
    assert.equal(state.sessions.length, 2)
    assert.deepEqual(
      state.sessions.map((entry) => entry.title),
      ['PowerShell', 'PowerShell 2']
    )
    assert.equal(state.activeId, '22222222-2222-4222-8222-222222222222')
    const ids = new Set(state.sessions.map((entry) => entry.id))
    assert.equal(ids.size, 2)
  })

  it('titles never reuse suffixes freed by kills', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = start(state, 'k2', '22222222-2222-4222-8222-222222222222')
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: '11111111-1111-4111-8111-111111111111' })
    state = start(state, 'k3', '33333333-3333-4333-8333-333333333333')
    assert.deepEqual(
      state.sessions.map((entry) => entry.title),
      ['PowerShell 2', 'PowerShell 3']
    )
  })

  it('nextTerminalTitle derives deterministic shell names', () => {
    assert.deepEqual(nextTerminalTitle([], {}, 'PowerShell'), { title: 'PowerShell', counters: {} })
    const titled = nextTerminalTitle([{ id: 'a', shell: 'PowerShell', title: 'PowerShell', status: 'running', error: null, exit: null }], {}, 'PowerShell')
    assert.equal(titled.title, 'PowerShell 2')
    assert.deepEqual(titled.counters, { PowerShell: 2 })
  })

  it('failed starts remove the pending entry and keep selection valid', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = terminalSessionsReducer(state, { type: 'start-requested', key: 'k2' })
    state = terminalSessionsReducer(state, { type: 'start-failed', key: 'k2', message: 'We couldn’t start the terminal.' })
    assert.deepEqual(state.pending, [])
    assert.equal(state.sessions.length, 1)
    assert.equal(state.activeId, '11111111-1111-4111-8111-111111111111')
    assert.equal(state.notice, 'We couldn’t start the terminal.')
  })

  it('enforces the human cap with no eviction', () => {
    assert.equal(MAX_HUMAN_TERMINALS, 8)
    let state = bound()
    for (let index = 0; index < MAX_HUMAN_TERMINALS; index += 1) {
      state = start(state, `k${index}`, `0000000${index}-0000-4000-8000-000000000000`)
    }
    assert.equal(canCreateTerminal(state), false)
    const before = state.sessions.map((entry) => entry.id)
    const refused = terminalSessionsReducer(state, { type: 'start-requested', key: 'overflow' })
    assert.deepEqual(refused.pending, [])
    assert.deepEqual(
      refused.sessions.map((entry) => entry.id),
      before
    )
    assert.equal(
      TERMINAL_LIMIT_NOTICE,
      'Too many terminals are open. Close one before creating another.'
    )
  })

  it('removing the active terminal selects a live neighbor', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = start(state, 'k2', '22222222-2222-4222-8222-222222222222')
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: '22222222-2222-4222-8222-222222222222' })
    assert.equal(state.sessions.length, 1)
    assert.equal(state.activeId, '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(visibleTerminalIds(state), ['11111111-1111-4111-8111-111111111111'])
  })

  it('close-requested hides presentation immediately but retains the instance', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    // Active B ×: row, pane, and replacement resolve in this single
    // transition — no exit event was (or needed to be) dispatched —
    // while B's session (and mounted xterm) is retained for the
    // outcome below.
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA, idB]
    )
    assert.deepEqual(state.closingIds, [idB])
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    // The survivor instance is untouched (same entry, still running).
    assert.equal(state.sessions[0]?.status, 'running')
    assert.equal(state.sessions[0]?.title, 'PowerShell')
  })

  it('close-finalized disposes the retained instance after initiation', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    const again = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.equal(again, state)
  })

  it('close-aborted restores the same instance with its buffer intact', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    // Initiation failed and B may still be alive: the SAME retained
    // session becomes visible again (never a recreated empty one),
    // reselected for retry, with calm copy.
    state = terminalSessionsReducer(state, {
      type: 'close-aborted',
      sessionId: idB,
      message: 'We couldn’t close the terminal.'
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA, idB]
    )
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.activeId, idB)
    assert.deepEqual(visibleTerminalIds(state), [idB])
    assert.equal(state.sessions[1]?.status, 'running')
    assert.equal(state.sessions[1]?.title, 'PowerShell 2')
    assert.equal(state.notice, 'We couldn’t close the terminal.')
  })

  it('duplicate close-requested is a single-flight no-op', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    let state = start(bound(), 'k1', idA)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idA })
    const again = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idA })
    assert.equal(again, state)
    const unknown = terminalSessionsReducer(state, { type: 'close-requested', sessionId: '99999999-9999-4999-8999-999999999999' })
    assert.equal(unknown, state)
  })

  it('closing an inactive terminal leaves the active viewport undisturbed', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idA })
    assert.equal(state.activeId, idB)
    assert.deepEqual(visibleTerminalIds(state), [idB])
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA, idB]
    )
    assert.deepEqual(state.closingIds, [idA])
    assert.equal(state.sessions[1]?.status, 'running')
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idA })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idB]
    )
    assert.equal(state.activeId, idB)
  })

  it('late exit after optimistic close finalizes removal (EXIT wins the race)', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    // EXIT is authoritative while closing: it finalizes removal at
    // once (no Exited row, no close error). A late kill response for
    // the same attempt is then a harmless no-op.
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: 0, signal: null }
    })
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.activeId, idA)
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.equal(state.notice, null)
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
  })

  it('closing terminal cannot be selected, split, or duplicated', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idA })
    const selected = terminalSessionsReducer(state, { type: 'session-selected', sessionId: idA })
    assert.equal(selected, state)
    const split = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    assert.equal(split, state)
  })

  it('split member close collapses the survivor immediately', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    assert.equal(state.splitIds, null)
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.equal(state.splitRatio, null)
    // The closing member is retained (hidden) until finalized.
    assert.equal(state.sessions.length, 2)
    assert.deepEqual(state.closingIds, [idB])
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.equal(state.sessions.length, 1)
    assert.deepEqual(visibleTerminalIds(state), [idA])
  })

  it('removing the final terminal reaches the safe empty state', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: '11111111-1111-4111-8111-111111111111' })
    assert.deepEqual(state.sessions, [])
    assert.equal(state.activeId, null)
    assert.deepEqual(visibleTerminalIds(state), [])
    assert.equal(state.splitRatio, null)
  })

  it('exit marks the instance without removing it; unknown exits are ignored', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: '11111111-1111-4111-8111-111111111111', exitCode: 0, signal: null }
    })
    assert.equal(state.sessions[0]?.status, 'exited')
    assert.equal(state.sessions.length, 1)
    const same = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: '99999999-9999-4999-8999-999999999999', exitCode: 0, signal: null }
    })
    assert.equal(same, state)
  })

  it('row selection cycles A → B → A without touching instances', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    const before = state.sessions.map((entry) => entry.id)
    // Click row A (inactive): single view follows, both PTYs retained.
    state = terminalSessionsReducer(state, { type: 'session-selected', sessionId: idA })
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      before
    )
    // Click row B: viewport follows back; nothing created or killed.
    state = terminalSessionsReducer(state, { type: 'session-selected', sessionId: idB })
    assert.equal(state.activeId, idB)
    assert.deepEqual(visibleTerminalIds(state), [idB])
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      before
    )
    assert.deepEqual(
      state.sessions.map((entry) => entry.title),
      ['PowerShell', 'PowerShell 2']
    )
  })

  it('split outsider click singles the view; split member click keeps the split', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const idC = '33333333-3333-4333-8333-333333333333'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = start(state, 'k3', idC)
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    // Member click: active moves, split intact.
    state = terminalSessionsReducer(state, { type: 'session-selected', sessionId: idB })
    assert.equal(state.activeId, idB)
    assert.deepEqual(visibleTerminalIds(state), [idA, idB])
    assert.deepEqual(state.splitIds, [idA, idB])
    assert.equal(state.sessions.length, 3)
    // Outsider click: deterministic single view, no instance touched.
    state = terminalSessionsReducer(state, { type: 'session-selected', sessionId: idC })
    assert.equal(state.activeId, idC)
    assert.deepEqual(visibleTerminalIds(state), [idC])
    assert.equal(state.splitIds, null)
    assert.equal(state.splitRatio, null)
    assert.equal(state.sessions.length, 3)
    state = terminalSessionsReducer(state, { type: 'split-closed' })
    assert.deepEqual(visibleTerminalIds(state), [idC])
  })

  it('split guards reject unknown ids, duplicates, and stray ratios', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    const invalid = terminalSessionsReducer(state, {
      type: 'split-opened',
      sessionIds: ['11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999']
    })
    assert.equal(invalid, state)
    const dupe = terminalSessionsReducer(state, {
      type: 'split-opened',
      sessionIds: ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111']
    })
    assert.equal(dupe, state)
    state = start(state, 'k2', '22222222-2222-4222-8222-222222222222')
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] })
    assert.deepEqual(state.splitIds, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
    assert.equal(state.splitRatio, 0.5)
    const clamped = terminalSessionsReducer(state, { type: 'split-ratio-changed', ratio: 0.95 })
    assert.equal(clamped.splitRatio, 0.5)
    const moved = terminalSessionsReducer(state, { type: 'split-ratio-changed', ratio: 0.35 })
    assert.equal(moved.splitRatio, 0.35)
    const singled = terminalSessionsReducer(moved, { type: 'split-closed' })
    const singleRatio = terminalSessionsReducer(singled, { type: 'split-ratio-changed', ratio: 0.4 })
    assert.equal(singleRatio.splitRatio, null)
  })

  it('new start while split exits split to the new terminal alone', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = start(state, 'k2', '22222222-2222-4222-8222-222222222222')
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] })
    state = start(state, 'k3', '33333333-3333-4333-8333-333333333333')
    assert.equal(state.splitIds, null)
    assert.deepEqual(visibleTerminalIds(state), ['33333333-3333-4333-8333-333333333333'])
    assert.equal(state.sessions.length, 3)
  })

  it('killing one split member collapses the survivor to single view', () => {
    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: idB })
    assert.equal(state.splitIds, null)
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.equal(state.sessions.length, 1)
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: idA })
    assert.equal(state.splitIds, null)
    assert.deepEqual(visibleTerminalIds(state), [])
  })

  it('routes data only to live sessions', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    assert.deepEqual(routeTerminalDataToSession(state, { sessionId: '11111111-1111-4111-8111-111111111111', data: 'hi' }), {
      sessionId: '11111111-1111-4111-8111-111111111111',
      data: 'hi'
    })
    assert.equal(routeTerminalDataToSession(state, { sessionId: '99999999-9999-4999-8999-999999999999', data: 'stale' }), null)
    state = terminalSessionsReducer(state, { type: 'session-removed', sessionId: '11111111-1111-4111-8111-111111111111' })
    assert.equal(routeTerminalDataToSession(state, { sessionId: '11111111-1111-4111-8111-111111111111', data: 'late' }), null)
  })

  it('workspace change resets everything', () => {
    let state = start(bound(), 'k1', '11111111-1111-4111-8111-111111111111')
    state = terminalSessionsReducer(state, { type: 'workspace-changed', workspaceId: 10 })
    assert.deepEqual(state.sessions, [])
    assert.equal(state.activeId, null)
    assert.equal(state.workspaceId, 10)
  })

  it('clamps resize dimensions into main-enforced bounds', () => {
    assert.deepEqual(clampTerminalDimensions(100, 30), { cols: 100, rows: 30 })
    assert.deepEqual(clampTerminalDimensions(5, 1), { cols: 20, rows: 5 })
    assert.deepEqual(clampTerminalDimensions(600, 500), { cols: 500, rows: 200 })
  })

  it('guards workspace switching while a terminal runs', () => {
    setTerminalActive(false)
    assert.equal(hasActiveTerminal(), false)
    assert.equal(confirmCloseTerminalAndSwitch(() => true), true)
    setTerminalActive(true)
    assert.equal(hasActiveTerminal(), true)
    assert.equal(confirmCloseTerminalAndSwitch(() => false), false)
    assert.equal(confirmCloseTerminalAndSwitch(() => true), true)
    assert.equal(TERMINAL_SWITCH_CONFIRM_MESSAGE, 'Close the active terminal and switch projects?')
    setTerminalActive(false)
  })
})

describe('terminal close race (exit wins)', () => {
  const idA = '11111111-1111-4111-8111-111111111111'
  const idB = '22222222-2222-4222-8222-222222222222'
  const idC = '33333333-3333-4333-8333-333333333333'
  const CLOSE_ERROR = 'We couldn’t close the terminal.'

  function twoRunning(): TerminalSessionsState {
    const state = start(bound(), 'k1', idA)
    return start(state, 'k2', idB)
  }

  it('CASE 1: KILL_RESULT initiated then EXIT finalizes exactly once', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.notice, null)
    // Delayed EXIT for the already-finalized id is ignored: no
    // resurrection, no duplicate, no error.
    const before = state
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: 0, signal: null }
    })
    assert.equal(state, before)
    const again = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.equal(again, state)
  })

  it('CASE 2: EXIT before KILL_RESULT finalizes and the late result is ignored', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: 0, signal: null }
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.notice, null)
    // Late initiated result: no-op, no restore.
    const finalized = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.equal(finalized, state)
    // Late failure result: must not resurrect or show an error.
    const aborted = terminalSessionsReducer(state, { type: 'close-aborted', sessionId: idB, message: CLOSE_ERROR })
    assert.equal(aborted, state)
    assert.equal(state.notice, null)
  })

  it('CASE 3: EXIT then late failure/NotFound stays finalized with no error', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: 1, signal: null }
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    const aborted = terminalSessionsReducer(state, { type: 'close-aborted', sessionId: idB, message: CLOSE_ERROR })
    assert.equal(aborted, state)
    assert.equal(aborted.notice, null)
    assert.deepEqual(aborted.closingIds, [])
    assert.equal(aborted.activeId, idA)
  })

  it('CASE 4: already-exited cleanup finalizes immediately with no error', () => {
    let state = start(bound(), 'k1', idA)
    // Natural shell exit keeps the readable row (no auto-delete).
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idA, exitCode: 0, signal: null }
    })
    assert.equal(state.sessions[0]?.status, 'exited')
    assert.equal(state.sessions.length, 1)
    // × on the exited row finalizes presentation at once.
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idA })
    assert.deepEqual(state.sessions, [])
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.activeId, null)
    assert.equal(state.notice, null)
    assert.deepEqual(visibleTerminalIds(state), [])
  })

  it('CASE 5: genuine kill-initiation failure restores the live terminal with retry', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, { type: 'close-aborted', sessionId: idB, message: CLOSE_ERROR })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA, idB]
    )
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.activeId, idB)
    assert.deepEqual(visibleTerminalIds(state), [idB])
    assert.equal(state.sessions[1]?.status, 'running')
    assert.equal(state.notice, CLOSE_ERROR)
    // Retry is possible: a fresh close-request hides again and a
    // later success finalizes and clears the stale error.
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    assert.deepEqual(state.closingIds, [idB])
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.equal(state.notice, null)
  })

  it('CASE 6: host-crash exits each clean up locally per row with no error', () => {
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    // Host down delivers one honest exit per session (not closing):
    // rows stay as Exited for explicit per-row cleanup.
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idA, exitCode: null, signal: null }
    })
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: null, signal: null }
    })
    assert.equal(state.sessions[0]?.status, 'exited')
    assert.equal(state.sessions[1]?.status, 'exited')
    // × on one exited row removes only that row.
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idA })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idB]
    )
    assert.equal(state.sessions[0]?.status, 'exited')
    assert.equal(state.notice, null)
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.deepEqual(state.sessions, [])
    assert.equal(state.notice, null)
  })

  it('CASE 7: closing A leaves B/C untouched (per-terminal independence)', () => {
    let state = start(bound(), 'k1', idA)
    state = start(state, 'k2', idB)
    state = start(state, 'k3', idC)
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idA })
    assert.deepEqual(state.closingIds, [idA])
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idA, exitCode: 0, signal: null }
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idB, idC]
    )
    assert.equal(state.sessions[0]?.status, 'running')
    assert.equal(state.sessions[1]?.status, 'running')
    assert.deepEqual(state.closingIds, [])
    // Sibling titles/statuses unchanged; active fell to a live neighbor.
    assert.deepEqual(
      state.sessions.map((entry) => entry.title),
      ['PowerShell 2', 'PowerShell 3']
    )
  })

  it('close-aborted on an exited session finalizes silently instead of restoring', () => {
    let state = start(bound(), 'k1', idA)
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idA, exitCode: 0, signal: null }
    })
    // A stale failure arriving for an already-exited row must clean
    // up locally with no "couldn’t close" notice.
    state = terminalSessionsReducer(state, { type: 'close-aborted', sessionId: idA, message: CLOSE_ERROR })
    assert.deepEqual(state.sessions, [])
    assert.deepEqual(state.closingIds, [])
    assert.equal(state.notice, null)
  })

  it('stale close-aborted after finalize never sets a close error', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idB })
    assert.equal(state.notice, null)
    const stale = terminalSessionsReducer(state, { type: 'close-aborted', sessionId: idB, message: CLOSE_ERROR })
    assert.equal(stale, state)
    assert.equal(stale.notice, null)
  })

  it('natural exit inside a split keeps the readable pair until closed', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    // Shell in A ends naturally (not closing): the pair stays so the
    // output remains readable — never a blank pane, never 3 panes.
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idA, exitCode: 0, signal: null }
    })
    assert.equal(state.sessions[0]?.status, 'exited')
    assert.deepEqual(state.splitIds, [idA, idB])
    assert.deepEqual(visibleTerminalIds(state), [idA, idB])
    // × on the exited member collapses the survivor to single view.
    state = terminalSessionsReducer(state, { type: 'close-finalized', sessionId: idA })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idB]
    )
    assert.equal(state.splitIds, null)
    assert.deepEqual(visibleTerminalIds(state), [idB])
  })

  it('concurrent creations never exceed the cap or strand pending entries', () => {
    let state = bound()
    for (let index = 0; index < MAX_HUMAN_TERMINALS; index += 1) {
      state = terminalSessionsReducer(state, { type: 'start-requested', key: `k${index}` })
    }
    assert.equal(canCreateTerminal(state), false)
    // One more concurrent request is refused without a pending entry.
    const refused = terminalSessionsReducer(state, { type: 'start-requested', key: 'k-overflow' })
    assert.deepEqual(refused.pending.length, MAX_HUMAN_TERMINALS)
    // Each in-flight creation settles exactly once; unknown keys never
    // create entries (stale late success after a switch is dropped).
    state = terminalSessionsReducer(state, {
      type: 'start-succeeded',
      key: 'k0',
      session: session(idA),
      title: ''
    })
    assert.equal(state.sessions.length, 1)
    const stale = terminalSessionsReducer(state, {
      type: 'start-succeeded',
      key: 'k-unknown',
      session: session(idB),
      title: ''
    })
    assert.equal(stale, state)
  })

  it('split state stays valid across an EXIT-wins close', () => {
    let state = twoRunning()
    state = terminalSessionsReducer(state, { type: 'split-opened', sessionIds: [idA, idB] })
    assert.deepEqual(state.splitIds, [idA, idB])
    state = terminalSessionsReducer(state, { type: 'close-requested', sessionId: idB })
    assert.equal(state.splitIds, null)
    state = terminalSessionsReducer(state, {
      type: 'exit-received',
      exit: { sessionId: idB, exitCode: 0, signal: null }
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [idA]
    )
    assert.equal(state.activeId, idA)
    assert.deepEqual(visibleTerminalIds(state), [idA])
    assert.deepEqual(state.closingIds, [])
  })
})
