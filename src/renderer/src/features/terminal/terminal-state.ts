import type { TerminalExitEvent, TerminalSession } from '../../../../shared/terminal/types'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from './terminal-dimensions'

export { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS }

/**
 * Pure terminal panel state (Stage 11). No xterm, no IPC here — the
 * component owns side effects, this module owns transitions, so the
 * lifecycle is unit-testable: closed initial state, explicit start,
 * running, exit, stale-session data filtering, and workspace reset.
 */

export type TerminalPanelStatus = 'closed' | 'starting' | 'running' | 'exited'

export interface TerminalPanelState {
  readonly status: TerminalPanelStatus
  readonly session: TerminalSession | null
  readonly error: string | null
  readonly exit: TerminalExitEvent | null
}

export function initialTerminalState(): TerminalPanelState {
  return { status: 'closed', session: null, error: null, exit: null }
}

export type TerminalPanelAction =
  | { readonly type: 'start-requested' }
  | { readonly type: 'start-succeeded'; readonly session: TerminalSession }
  | { readonly type: 'start-failed'; readonly message: string }
  | { readonly type: 'exit-received'; readonly exit: TerminalExitEvent }
  | { readonly type: 'kill-requested' }
  | { readonly type: 'closed' }
  | { readonly type: 'workspace-changed' }

function isCurrentSession(state: TerminalPanelState, sessionId: string): boolean {
  return state.session !== null && state.session.id === sessionId
}

export function terminalPanelReducer(
  state: TerminalPanelState,
  action: TerminalPanelAction
): TerminalPanelState {
  switch (action.type) {
    case 'start-requested':
      if (state.status === 'starting' || state.status === 'running') {
        return state
      }
      return { status: 'starting', session: null, error: null, exit: null }
    case 'start-succeeded':
      return { status: 'running', session: action.session, error: null, exit: null }
    case 'start-failed':
      return { status: 'closed', session: null, error: action.message, exit: null }
    case 'exit-received':
      if (!isCurrentSession(state, action.exit.sessionId)) {
        return state
      }
      return { ...state, status: 'exited', exit: action.exit }
    case 'kill-requested':
      if (state.status !== 'running' && state.status !== 'exited') {
        return state
      }
      return { ...state, status: 'exited', exit: state.exit }
    case 'closed':
      return initialTerminalState()
    case 'workspace-changed':
      return initialTerminalState()
    default:
      return state
  }
}

/**
 * Routes an incoming PTY data event to the current session only.
 * Returns the payload when it belongs to the active session and the
 * panel is running; otherwise null (stale sessions are ignored).
 */
export function routeTerminalData(
  state: TerminalPanelState,
  event: { readonly sessionId: string; readonly data: string }
): string | null {
  if (state.status !== 'running' || !isCurrentSession(state, event.sessionId)) {
    return null
  }
  return event.data
}

/** Clamps FitAddon-measured dimensions into the main-enforced bounds. */
export function clampTerminalDimensions(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isInteger(cols) ? cols : DEFAULT_TERMINAL_COLS
  const safeRows = Number.isInteger(rows) ? rows : DEFAULT_TERMINAL_ROWS
  return {
    cols: Math.min(500, Math.max(20, safeCols)),
    rows: Math.min(200, Math.max(5, safeRows))
  }
}
