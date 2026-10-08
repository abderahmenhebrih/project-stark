import type { OrchestrationRun } from '../../../../shared/orchestration/types'

/**
 * Pure Stage 18 Work UX state (no React imports) so run flight,
 * details, retry, and workspace/session isolation are unit-testable
 * with the Node runner. Mirrors the proposal pattern: cross-workspace
 * and cross-session outcomes are rejected, switching clears transient
 * run state. No timers, no polling, no fake progress, no automatic
 * retry lives here.
 *
 * Flight honesty: a single `runBrain` invoke cannot report
 * intermediate provider stages, so flight shows one preparing state.
 * Step-level Plan / Worker result / Final response detail comes from
 * the persisted run after completion.
 */

export interface WorkPanelState {
  readonly workspaceId: number | null
  readonly sessionId: number | null
  readonly preparing: boolean
  readonly run: OrchestrationRun | null
  readonly error: string | null
}

export function initialWorkPanelState(): WorkPanelState {
  return { workspaceId: null, sessionId: null, preparing: false, run: null, error: null }
}

export type WorkPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'session-changed'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'run-started'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'run-succeeded'; readonly workspaceId: number; readonly sessionId: number; readonly run: OrchestrationRun }
  | { readonly type: 'run-failed'; readonly workspaceId: number; readonly sessionId: number; readonly message: string }
  | { readonly type: 'run-dismissed'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'run-retried'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'runs-loaded'; readonly workspaceId: number; readonly sessionId: number; readonly run: OrchestrationRun | null }

function isCurrent(state: WorkPanelState, workspaceId: number, sessionId: number): boolean {
  return state.workspaceId === workspaceId && state.sessionId === sessionId
}

export function workPanelReducer(state: WorkPanelState, action: WorkPanelAction): WorkPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialWorkPanelState(), workspaceId: action.workspaceId }
    case 'session-changed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...initialWorkPanelState(), workspaceId: action.workspaceId, sessionId: action.sessionId }
    }
    case 'run-started': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.preparing) {
        return state
      }
      return { ...state, preparing: true, run: null, error: null }
    }
    case 'run-succeeded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, preparing: false, run: action.run, error: null }
    }
    case 'run-failed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, preparing: false, run: null, error: action.message }
    }
    case 'run-dismissed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, run: null, error: null }
    }
    case 'run-retried': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.preparing) {
        return state
      }
      return { ...state, preparing: true, run: null, error: null }
    }
    case 'runs-loaded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.preparing) {
        return state
      }
      return { ...state, run: action.run, error: null }
    }
  }
}
