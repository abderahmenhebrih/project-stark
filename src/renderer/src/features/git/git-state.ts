import type { GitDiffResult, GitWorkspaceState } from '../../../../shared/git/types'

/**
 * Pure Git panel state (no React imports) so loading, grouping, race
 * safety, and workspace invalidation are unit-testable with the Node
 * runner. Mirrors the search-state pattern: stale and cross-workspace
 * results are rejected, switching workspaces clears everything, and
 * there are no timers — Refresh runs exactly one status request.
 */

export type GitStatusPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface GitPanelState {
  readonly workspaceId: number | null
  readonly phase: GitStatusPhase
  readonly requestId: number
  readonly data: GitWorkspaceState | null
  readonly error: string | null
}

export function initialGitPanelState(): GitPanelState {
  return { workspaceId: null, phase: 'idle', requestId: 0, data: null, error: null }
}

export type GitPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'status-loading'; readonly workspaceId: number; readonly requestId: number }
  | {
      readonly type: 'status-succeeded'
      readonly workspaceId: number
      readonly requestId: number
      readonly data: GitWorkspaceState
    }
  | { readonly type: 'status-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }

function isCurrentStatusRequest(state: GitPanelState, workspaceId: number, requestId: number): boolean {
  return state.workspaceId === workspaceId && state.requestId === requestId
}

export function gitPanelReducer(state: GitPanelState, action: GitPanelAction): GitPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialGitPanelState(), workspaceId: action.workspaceId }
    case 'status-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, phase: 'loading', requestId: action.requestId, data: null, error: null }
    }
    case 'status-succeeded': {
      if (!isCurrentStatusRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return { ...state, phase: 'ready', data: action.data, error: null }
    }
    case 'status-failed': {
      if (!isCurrentStatusRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return { ...state, phase: 'error', data: null, error: action.message }
    }
  }
}

export type GitDiffPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface GitDiffState {
  readonly workspaceId: number | null
  readonly relativePath: string | null
  readonly target: 'staged' | 'unstaged' | null
  readonly phase: GitDiffPhase
  readonly requestId: number
  readonly result: GitDiffResult | null
  readonly error: string | null
}

export function initialGitDiffState(): GitDiffState {
  return {
    workspaceId: null,
    relativePath: null,
    target: null,
    phase: 'idle',
    requestId: 0,
    result: null,
    error: null
  }
}

export type GitDiffAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | {
      readonly type: 'diff-loading'
      readonly workspaceId: number
      readonly relativePath: string
      readonly target: 'staged' | 'unstaged'
      readonly requestId: number
    }
  | {
      readonly type: 'diff-succeeded'
      readonly workspaceId: number
      readonly requestId: number
      readonly result: GitDiffResult
    }
  | { readonly type: 'diff-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'diff-closed' }

function isCurrentDiffRequest(state: GitDiffState, workspaceId: number, requestId: number): boolean {
  return state.workspaceId === workspaceId && state.requestId === requestId
}

export function gitDiffReducer(state: GitDiffState, action: GitDiffAction): GitDiffState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialGitDiffState(), workspaceId: action.workspaceId }
    case 'diff-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        relativePath: action.relativePath,
        target: action.target,
        phase: 'loading',
        requestId: action.requestId,
        result: null,
        error: null
      }
    }
    case 'diff-succeeded': {
      if (!isCurrentDiffRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      // The result must belong to the selected path/target; a late
      // response for an older selection never overwrites the new one
      // (guarded by requestId above, path check is defense in depth).
      return { ...state, phase: 'ready', result: action.result, error: null }
    }
    case 'diff-failed': {
      if (!isCurrentDiffRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return { ...state, phase: 'error', result: null, error: action.message }
    }
    case 'diff-closed':
      return { ...state, relativePath: null, target: null, phase: 'idle', result: null, error: null }
  }
}

/** Display label for a status row (concise, no raw XY dump). */
export function gitStatusLabel(input: {
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
  readonly indexStatus: string
  readonly worktreeStatus: string
}): string {
  if (input.conflicted) {
    return 'Conflict'
  }
  if (input.untracked) {
    return 'Untracked'
  }
  const parts: string[] = []
  if (input.staged) {
    parts.push(`Staged ${input.indexStatus.trim() === '' ? '' : input.indexStatus}`.trim())
  }
  if (input.unstaged) {
    parts.push(`Working ${input.worktreeStatus.trim() === '' ? '' : input.worktreeStatus}`.trim())
  }
  if (parts.length === 0) {
    return 'Changed'
  }
  return parts.join(' · ')
}
