import type { LooplinkPreview } from '../../../../shared/looplink/types'

/**
 * Pure Looplink panel state (no React imports) so continuity loading,
 * dismissal, and workspace/session isolation are unit-testable with
 * the Node runner. Mirrors the proposal pattern: cross-workspace and
 * cross-session outcomes are rejected. No timers, no polling, no
 * auto-send, no provider triggers lives here.
 */

export interface LooplinkPanelState {
  readonly workspaceId: number | null
  readonly sessionId: number | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly looplink: LooplinkPreview | null
  readonly acting: boolean
  readonly actionError: string | null
}

export function initialLooplinkPanelState(): LooplinkPanelState {
  return { workspaceId: null, sessionId: null, loading: false, loadError: null, looplink: null, acting: false, actionError: null }
}

export type LooplinkPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'session-changed'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'continuity-loading'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'continuity-loaded'; readonly workspaceId: number; readonly sessionId: number; readonly looplink: LooplinkPreview | null }
  | { readonly type: 'continuity-failed'; readonly workspaceId: number; readonly sessionId: number; readonly message: string }
  | { readonly type: 'action-started'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'action-succeeded'; readonly workspaceId: number; readonly sessionId: number; readonly looplink: LooplinkPreview | null }
  | { readonly type: 'action-failed'; readonly workspaceId: number; readonly sessionId: number; readonly message: string }

function isCurrent(state: LooplinkPanelState, workspaceId: number, sessionId: number): boolean {
  return state.workspaceId === workspaceId && state.sessionId === sessionId
}

export function looplinkPanelReducer(state: LooplinkPanelState, action: LooplinkPanelAction): LooplinkPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialLooplinkPanelState(), workspaceId: action.workspaceId }
    case 'session-changed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...initialLooplinkPanelState(), workspaceId: action.workspaceId, sessionId: action.sessionId }
    }
    case 'continuity-loading': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, loading: true, loadError: null }
    }
    case 'continuity-loaded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, loading: false, loadError: null, looplink: action.looplink, actionError: null }
    }
    case 'continuity-failed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, loading: false, loadError: action.message }
    }
    case 'action-started': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.acting) {
        return state
      }
      return { ...state, acting: true, actionError: null }
    }
    case 'action-succeeded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, acting: false, looplink: action.looplink, actionError: null }
    }
    case 'action-failed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, acting: false, actionError: action.message }
    }
  }
}
