import type {
  WorkspaceSearchMatch,
  WorkspaceSearchResult
} from '../../../../shared/workspace-search/types'

/**
 * Pure search UI state (no React imports) so submission, loading, race
 * safety, and workspace invalidation are unit-testable with the Node
 * runner. Mirrors the explorer-state pattern: stale and cross-workspace
 * results are rejected, and switching workspaces clears everything.
 */

export interface WorkspaceSearchPanelState {
  readonly workspaceId: number | null
  readonly query: string
  readonly caseSensitive: boolean
  readonly loading: boolean
  readonly requestId: number
  readonly matches: readonly WorkspaceSearchMatch[]
  readonly filesScanned: number
  readonly filesMatched: number
  readonly truncated: boolean
  readonly error: string | null
  readonly submitted: boolean
}

export function initialSearchState(): WorkspaceSearchPanelState {
  return {
    workspaceId: null,
    query: '',
    caseSensitive: false,
    loading: false,
    requestId: 0,
    matches: [],
    filesScanned: 0,
    filesMatched: 0,
    truncated: false,
    error: null,
    submitted: false
  }
}

export type SearchPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | {
      readonly type: 'search-started'
      readonly workspaceId: number
      readonly query: string
      readonly caseSensitive: boolean
      readonly requestId: number
    }
  | { readonly type: 'search-succeeded'; readonly workspaceId: number; readonly requestId: number; readonly result: WorkspaceSearchResult }
  | { readonly type: 'search-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'search-cleared'; readonly workspaceId: number }

function isCurrentRequest(state: WorkspaceSearchPanelState, workspaceId: number, requestId: number): boolean {
  return state.workspaceId === workspaceId && state.requestId === requestId
}

export function searchPanelReducer(
  state: WorkspaceSearchPanelState,
  action: SearchPanelAction
): WorkspaceSearchPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialSearchState(), workspaceId: action.workspaceId }
    case 'search-started': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        query: action.query,
        caseSensitive: action.caseSensitive,
        loading: true,
        requestId: action.requestId,
        matches: [],
        filesScanned: 0,
        filesMatched: 0,
        truncated: false,
        error: null,
        submitted: true
      }
    }
    case 'search-succeeded': {
      if (!isCurrentRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return {
        ...state,
        loading: false,
        matches: action.result.matches,
        filesScanned: action.result.filesScanned,
        filesMatched: action.result.filesMatched,
        truncated: action.result.truncated,
        error: null
      }
    }
    case 'search-failed': {
      if (!isCurrentRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return { ...state, loading: false, error: action.message }
    }
    case 'search-cleared': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        query: '',
        loading: false,
        requestId: state.requestId + 1,
        matches: [],
        filesScanned: 0,
        filesMatched: 0,
        truncated: false,
        error: null,
        submitted: false
      }
    }
  }
}
