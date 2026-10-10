import type { TerminalExitEvent, TerminalSession } from '../../../../shared/terminal/types'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from './terminal-dimensions'

export { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS }

/**
 * Pure multi-terminal session state. No xterm, no IPC here — the
 * Explorer owns side effects, this module owns transitions, so the
 * lifecycle is unit-testable: explicit starts per terminal, running,
 * exit, exact removal, active selection, split visibility, the human
 * cap, and workspace reset.
 *
 * Three concepts stay strictly separate (VS Code model):
 * - sessions: every live human terminal (drawer lists all of these).
 * - activeId: the single selected terminal (magenta row, input focus).
 * - splitIds: the explicit split pair, or null in normal single view.
 * Only Split Terminal ever sets splitIds; New, Duplicate, plain
 * selection, and kills always resolve back to single view. Two
 * canvases without an explicit split are unrepresentable.
 *
 * Human terminals only: worker/runtime/extension processes never
 * appear here. Live PTYs are runtime resources — never persisted, so
 * restart assumes nothing alive. Schema untouched (v19).
 */

export type HumanTerminalStatus = 'starting' | 'running' | 'exited'

export interface HumanTerminalEntry {
  /** Opaque main-owned session id (stable per PTY). */
  readonly id: string
  /** Shell label from main (e.g. PowerShell). */
  readonly shell: string
  /** Deterministic drawer/viewport title (e.g. PowerShell 2). */
  readonly title: string
  readonly status: HumanTerminalStatus
  /** Calm per-terminal failure copy (start failures only). */
  readonly error: string | null
  readonly exit: TerminalExitEvent | null
}

/** Pending creation (no PTY yet): tracked so failures clean up. */
export interface PendingTerminalEntry {
  readonly key: string
}

export interface TerminalSessionsState {
  readonly workspaceId: number | null
  readonly sessions: readonly HumanTerminalEntry[]
  /** Creations in flight (renderer-local keys, never PTYs). */
  readonly pending: readonly PendingTerminalEntry[]
  /** Active terminal for input/focus; always a live session id or null. */
  readonly activeId: string | null
  /**
   * Kills in flight (exact session ids): presentation is removed
   * immediately on close-requested while the backend kill completes
   * asynchronously; the id clears when its exit arrives. Bounds
   * double-close, and selection/split/duplicate never target these.
   * Renderer-local only, never persisted.
   */
  readonly closingIds: readonly string[]
  /**
   * Explicit split pair (two visible canvases) or null for the normal
   * single view. ONLY Split Terminal sets this; every other action
   * clears or preserves it per the selection rules below.
   */
  readonly splitIds: readonly [string, string] | null
  /** Split divider ratio (0..1, first pane share); null when single. */
  readonly splitRatio: number | null
  /** Per-shell title counters (monotonic, never reused after kills). */
  readonly titleCounters: Readonly<Record<string, number>>
  /** Calm global notice (cap reached, spawn failure). */
  readonly notice: string | null
}

export function initialTerminalSessionsState(): TerminalSessionsState {
  return {
    workspaceId: null,
    sessions: [],
    pending: [],
    activeId: null,
    closingIds: [],
    splitIds: null,
    splitRatio: null,
    titleCounters: {},
    notice: null
  }
}

/** Hard cap on live human terminals (main enforces authoritatively). */
export const MAX_HUMAN_TERMINALS = 8

/** Calm cap copy (mirrors the main-side limit error). */
export const TERMINAL_LIMIT_NOTICE = 'Too many terminals are open. Close one before creating another.'

/** True while a creation may start (below the cap). */
export function canCreateTerminal(state: TerminalSessionsState): boolean {
  return state.sessions.length + state.pending.length < MAX_HUMAN_TERMINALS
}

/**
 * Deterministic display title for a new terminal of one shell:
 * bare label while no sibling of that shell exists, otherwise a
 * monotonic suffix that is never reused after kills (PowerShell,
 * PowerShell 2, PowerShell 3, …).
 */
export function nextTerminalTitle(
  sessions: readonly HumanTerminalEntry[],
  counters: Readonly<Record<string, number>>,
  shell: string
): { readonly title: string; readonly counters: Readonly<Record<string, number>> } {
  const related = sessions.filter((entry) => entry.title === shell || entry.title.startsWith(`${shell} `))
  if (related.length === 0 && (counters[shell] ?? 0) === 0) {
    return { title: shell, counters }
  }
  const taken = new Set(sessions.map((entry) => entry.title))
  let suffix = Math.max(counters[shell] ?? 0, related.length) + 1
  while (taken.has(`${shell} ${suffix}`)) {
    suffix += 1
  }
  return { title: `${shell} ${suffix}`, counters: { ...counters, [shell]: suffix } }
}

export type TerminalSessionsAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'start-requested'; readonly key: string }
  | { readonly type: 'start-succeeded'; readonly key: string; readonly session: TerminalSession; readonly title: string }
  | { readonly type: 'start-failed'; readonly key: string; readonly message: string }
  | { readonly type: 'exit-received'; readonly exit: TerminalExitEvent }
  | { readonly type: 'close-requested'; readonly sessionId: string }
  | { readonly type: 'close-finalized'; readonly sessionId: string }
  | { readonly type: 'close-aborted'; readonly sessionId: string; readonly message: string }
  | { readonly type: 'session-removed'; readonly sessionId: string }
  | { readonly type: 'session-selected'; readonly sessionId: string }
  | { readonly type: 'split-opened'; readonly sessionIds: readonly [string, string] }
  | { readonly type: 'split-ratio-changed'; readonly ratio: number }
  | { readonly type: 'split-closed' }
  | { readonly type: 'notice-shown'; readonly message: string }
  | { readonly type: 'notice-dismissed' }

function liveIds(state: TerminalSessionsState): readonly string[] {
  return state.sessions.map((entry) => entry.id)
}

/**
 * The single ordered list of ids the viewport renders: the explicit
 * split pair while split, otherwise exactly the active terminal.
 * Closing terminals are never visible (presentation hides on
 * close-requested) while their instances stay mounted until
 * close-finalized — so a failed kill restores the same xterm with
 * its buffer intact instead of recreating an empty one.
 */
export function visibleTerminalIds(state: TerminalSessionsState): readonly string[] {
  const ids = new Set(liveIds(state))
  const open = (id: string): boolean => ids.has(id) && !state.closingIds.includes(id)
  if (state.splitIds !== null) {
    const [first, second] = state.splitIds
    if (open(first) && open(second)) {
      return [first, second]
    }
  }
  return state.activeId !== null && open(state.activeId) ? [state.activeId] : []
}

function withValidSelection(state: TerminalSessionsState): TerminalSessionsState {
  const ids = new Set(liveIds(state).filter((id) => !state.closingIds.includes(id)))
  const activeId = state.activeId !== null && ids.has(state.activeId) ? state.activeId : [...ids][0] ?? null
  const splitIds =
    state.splitIds !== null && ids.has(state.splitIds[0]) && ids.has(state.splitIds[1]) ? state.splitIds : null
  return {
    ...state,
    activeId,
    splitIds,
    splitRatio: splitIds !== null ? (state.splitRatio ?? 0.5) : null
  }
}

export function terminalSessionsReducer(
  state: TerminalSessionsState,
  action: TerminalSessionsAction
): TerminalSessionsState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialTerminalSessionsState(), workspaceId: action.workspaceId }
    case 'start-requested': {
      if (state.workspaceId === null || !canCreateTerminal(state)) {
        return state
      }
      return {
        ...state,
        pending: [...state.pending, { key: action.key }],
        notice: null
      }
    }
    case 'start-succeeded': {
      if (!state.pending.some((entry) => entry.key === action.key)) {
        return state
      }
      const titled = nextTerminalTitle(state.sessions, state.titleCounters, action.session.shell)
      const entry: HumanTerminalEntry = {
        id: action.session.id,
        shell: action.session.shell,
        title: action.title !== '' ? action.title : titled.title,
        status: 'running',
        error: null,
        exit: null
      }
      return {
        ...state,
        sessions: [...state.sessions, entry],
        pending: state.pending.filter((pending) => pending.key !== action.key),
        titleCounters: action.title !== '' ? state.titleCounters : titled.counters,
        activeId: entry.id,
        // New/Duplicate always land in normal single view, even when
        // invoked while split (VS Code-like; the pair keeps running).
        splitIds: null,
        splitRatio: null,
        notice: null
      }
    }
    case 'start-failed': {
      if (!state.pending.some((entry) => entry.key === action.key)) {
        return state
      }
      // Failed creations leave no instance behind; the selection stays
      // valid and the failure surfaces as calm notice copy only.
      return {
        ...state,
        pending: state.pending.filter((pending) => pending.key !== action.key),
        notice: action.message
      }
    }
    case 'exit-received': {
      // A late exit for an optimistically closed terminal only clears
      // its in-flight kill tracking (presentation left on
      // close-requested; main removed its own bookkeeping too).
      const known = state.sessions.some((entry) => entry.id === action.exit.sessionId)
      const wasClosing = state.closingIds.includes(action.exit.sessionId)
      if (!known && !wasClosing) {
        return state
      }
      return {
        ...state,
        closingIds: wasClosing ? state.closingIds.filter((id) => id !== action.exit.sessionId) : state.closingIds,
        sessions: known
          ? state.sessions.map((entry) =>
              entry.id === action.exit.sessionId ? { ...entry, status: 'exited' as const, exit: action.exit } : entry
            )
          : state.sessions
      }
    }
    case 'close-requested': {
      // Immediate presentation hide in the same tick — drawer row,
      // viewport pane, replacement selection, and split collapse all
      // resolve now — while the SESSION IS RETAINED with its mounted
      // xterm: only close-finalized unmounts it. Unknown or already
      // closing ids are no-ops (single-flight).
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) ||
        state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      return withValidSelection({
        ...state,
        closingIds: [...state.closingIds, action.sessionId],
        notice: null
      })
    }
    case 'close-finalized': {
      // Termination initiated (or already gone): the instance may now
      // unmount and dispose. Unknown ids are no-ops.
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) &&
        !state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      return withValidSelection({
        ...state,
        sessions: state.sessions.filter((entry) => entry.id !== action.sessionId),
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        notice: null
      })
    }
    case 'close-aborted': {
      // Initiation failed and the terminal may still be alive: clear
      // closing, reshow the SAME retained instance (buffer intact —
      // never a recreated empty terminal), and reselect it so the
      // user can retry. Deterministic in every case.
      if (!state.sessions.some((entry) => entry.id === action.sessionId)) {
        return state.closingIds.includes(action.sessionId)
          ? { ...state, closingIds: state.closingIds.filter((id) => id !== action.sessionId), notice: action.message }
          : state
      }
      return {
        ...state,
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        activeId: action.sessionId,
        splitIds: null,
        splitRatio: null,
        notice: action.message
      }
    }
    case 'session-removed': {
      if (!state.sessions.some((entry) => entry.id === action.sessionId)) {
        return state
      }
      return withValidSelection({
        ...state,
        sessions: state.sessions.filter((entry) => entry.id !== action.sessionId),
        closingIds: state.closingIds.filter((id) => id !== action.sessionId),
        notice: null
      })
    }
    case 'session-selected': {
      if (
        !state.sessions.some((entry) => entry.id === action.sessionId) ||
        state.closingIds.includes(action.sessionId)
      ) {
        return state
      }
      // Split member click keeps the pair (and its ratio); any other
      // click exits split presentation to that terminal alone. Both
      // split PTYs keep running in the background either way.
      const keepSplit = state.splitIds !== null && state.splitIds.includes(action.sessionId)
      return {
        ...state,
        activeId: action.sessionId,
        splitIds: keepSplit ? state.splitIds : null,
        splitRatio: keepSplit ? state.splitRatio : null,
        notice: null
      }
    }
    case 'split-opened': {
      const [first, second] = action.sessionIds
      const ids = new Set(liveIds(state).filter((id) => !state.closingIds.includes(id)))
      if (!ids.has(first) || !ids.has(second) || first === second) {
        return state
      }
      return { ...state, activeId: first, splitIds: [first, second], splitRatio: state.splitRatio ?? 0.5, notice: null }
    }
    case 'split-ratio-changed': {
      if (state.splitIds === null) {
        return state
      }
      if (!Number.isFinite(action.ratio) || action.ratio < 0.2 || action.ratio > 0.8) {
        return state
      }
      return { ...state, splitRatio: action.ratio }
    }
    case 'split-closed': {
      if (state.splitIds === null) {
        return state
      }
      const active = state.activeId !== null && state.splitIds.includes(state.activeId) ? state.activeId : state.splitIds[0]
      if (active === undefined) {
        return state
      }
      return { ...state, activeId: active, splitIds: null, splitRatio: null }
    }
    case 'notice-dismissed':
      return { ...state, notice: null }
    case 'notice-shown':
      return { ...state, notice: action.message }
    default:
      return state
  }
}

/**
 * Routes an incoming PTY data event to a live session id.
 * Returns the payload when the session exists (any status that can
 * still hold a viewport); otherwise null (unknown/dead sessions are
 * ignored).
 */
export function routeTerminalDataToSession(
  state: TerminalSessionsState,
  event: { readonly sessionId: string; readonly data: string }
): { readonly sessionId: string; readonly data: string } | null {
  if (!state.sessions.some((entry) => entry.id === event.sessionId)) {
    return null
  }
  return { sessionId: event.sessionId, data: event.data }
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
