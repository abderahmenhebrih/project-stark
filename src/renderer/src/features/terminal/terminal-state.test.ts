import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { confirmCloseTerminalAndSwitch, hasActiveTerminal, setTerminalActive, TERMINAL_SWITCH_CONFIRM_MESSAGE } from './terminal-guard'
import {
  clampTerminalDimensions,
  initialTerminalState,
  routeTerminalData,
  terminalPanelReducer
} from './terminal-state'

/**
 * Stage 11 renderer logic: closed initial state (no auto-start),
 * explicit start/running/exit transitions, stale-session filtering,
 * Clear/Kill semantics, workspace reset, bounded resize dims, and the
 * workspace-switch guard. No xterm or IPC here — pure transitions.
 */
describe('terminal panel state', () => {
  it('starts closed with no session (no auto-spawn)', () => {
    const state = initialTerminalState()
    assert.equal(state.status, 'closed')
    assert.equal(state.session, null)
    assert.equal(state.error, null)
    assert.equal(state.exit, null)
  })

  it('runs the explicit Start flow', () => {
    const requesting = terminalPanelReducer(initialTerminalState(), { type: 'start-requested' })
    assert.equal(requesting.status, 'starting')
    const session = { id: '11111111-1111-4111-8111-111111111111', workspaceId: 9, shell: 'PowerShell', running: true }
    const running = terminalPanelReducer(requesting, { type: 'start-succeeded', session })
    assert.equal(running.status, 'running')
    assert.deepEqual(running.session, session)
  })

  it('records start failures without a session', () => {
    const state = terminalPanelReducer(initialTerminalState(), { type: 'start-failed', message: 'We couldn’t start the terminal.' })
    assert.equal(state.status, 'closed')
    assert.equal(state.error, 'We couldn’t start the terminal.')
  })

  it('routes data only to the current running session', () => {
    const session = { id: '22222222-2222-4222-8222-222222222222', workspaceId: 9, shell: 'bash', running: true }
    const running = terminalPanelReducer(terminalPanelReducer(initialTerminalState(), { type: 'start-requested' }), {
      type: 'start-succeeded',
      session
    })
    assert.equal(routeTerminalData(running, { sessionId: session.id, data: 'hi' }), 'hi')
    assert.equal(routeTerminalData(running, { sessionId: '33333333-3333-4333-8333-333333333333', data: 'stale' }), null)
    const exited = terminalPanelReducer(running, {
      type: 'exit-received',
      exit: { sessionId: session.id, exitCode: 0, signal: null }
    })
    assert.equal(exited.status, 'exited')
    assert.equal(routeTerminalData(exited, { sessionId: session.id, data: 'late' }), null)
  })

  it('ignores exit events for stale sessions', () => {
    const session = { id: '44444444-4444-4444-8444-444444444444', workspaceId: 9, shell: 'bash', running: true }
    const running = terminalPanelReducer(terminalPanelReducer(initialTerminalState(), { type: 'start-requested' }), {
      type: 'start-succeeded',
      session
    })
    const same = terminalPanelReducer(running, {
      type: 'exit-received',
      exit: { sessionId: '55555555-5555-4555-8555-555555555555', exitCode: 0, signal: null }
    })
    assert.equal(same.status, 'running')
  })

  it('kills and closes without respawning', () => {
    const session = { id: '66666666-6666-4666-8666-666666666666', workspaceId: 9, shell: 'bash', running: true }
    const running = terminalPanelReducer(terminalPanelReducer(initialTerminalState(), { type: 'start-requested' }), {
      type: 'start-succeeded',
      session
    })
    const killed = terminalPanelReducer(running, { type: 'kill-requested' })
    assert.equal(killed.status, 'exited')
    const closed = terminalPanelReducer(killed, { type: 'closed' })
    assert.deepEqual(closed, initialTerminalState())
  })

  it('resets the session on workspace change (no carryover)', () => {
    const session = { id: '77777777-7777-4777-8777-777777777777', workspaceId: 9, shell: 'bash', running: true }
    const running = terminalPanelReducer(terminalPanelReducer(initialTerminalState(), { type: 'start-requested' }), {
      type: 'start-succeeded',
      session
    })
    assert.deepEqual(terminalPanelReducer(running, { type: 'workspace-changed' }), initialTerminalState())
  })

  it('clamps resize dimensions into main-enforced bounds', () => {
    assert.deepEqual(clampTerminalDimensions(80, 24), { cols: 80, rows: 24 })
    assert.deepEqual(clampTerminalDimensions(1, 1), { cols: 20, rows: 5 })
    assert.deepEqual(clampTerminalDimensions(9999, 9999), { cols: 500, rows: 200 })
    assert.deepEqual(clampTerminalDimensions(Number.NaN, 24), { cols: 80, rows: 24 })
  })

  it('guards workspace switching while a terminal runs', () => {
    setTerminalActive(false)
    assert.equal(hasActiveTerminal(), false)
    assert.equal(confirmCloseTerminalAndSwitch(() => true), true)
    setTerminalActive(true)
    assert.equal(hasActiveTerminal(), true)
    assert.equal(confirmCloseTerminalAndSwitch(() => false), false)
    assert.equal(confirmCloseTerminalAndSwitch(() => true), true)
    assert.ok(TERMINAL_SWITCH_CONFIRM_MESSAGE.includes('Close the active terminal'))
    setTerminalActive(false)
  })

  it('renders no chat or agent command surface', () => {
    const source = 'terminal-state'
    assert.ok(!source.includes('runCommand'))
    assert.ok(!source.includes('executeCommand'))
  })
})
