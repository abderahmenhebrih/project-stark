import type { WorkspaceEntry } from '../../../../shared/workspace-files/types'

/**
 * Pure Explorer state transitions (no React imports) so tree behavior
 * is unit-testable with the Node runner: expansion, per-directory
 * loading/error records, file selection and preview, stale-result
 * rejection, and full reset on workspace change.
 */

export interface ExplorerFilePreview {
  readonly path: string
  readonly content: string | null
  readonly loading: boolean
  readonly error: string | null
  /** SHA-256 revision from the last successful read; null until loaded. */
  readonly revision: string | null
}

export interface ExplorerState {
  readonly workspaceId: number | null
  readonly expanded: readonly string[]
  readonly entries: Record<string, readonly WorkspaceEntry[]>
  readonly loading: readonly string[]
  readonly errors: Record<string, string>
  readonly selectedPath: string | null
  readonly preview: ExplorerFilePreview | null
}

export function initialExplorerState(): ExplorerState {
  return {
    workspaceId: null,
    expanded: [],
    entries: {},
    loading: [],
    errors: {},
    selectedPath: null,
    preview: null
  }
}

export type ExplorerAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'toggle'; readonly path: string }
  | { readonly type: 'directory-loading'; readonly path: string }
  | {
      readonly type: 'directory-loaded'
      readonly workspaceId: number
      readonly path: string
      readonly entries: readonly WorkspaceEntry[]
    }
  | { readonly type: 'directory-failed'; readonly path: string; readonly message: string }
  | { readonly type: 'file-selected'; readonly path: string }
  | {
      readonly type: 'file-loaded'
      readonly workspaceId: number
      readonly path: string
      readonly content: string
      readonly revision: string
    }
  | { readonly type: 'file-failed'; readonly path: string; readonly message: string }

function without<T>(values: readonly T[], value: T): T[] {
  return values.filter((entry) => entry !== value)
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const existing of Object.keys(record)) {
    if (existing !== key) {
      next[existing] = record[existing]
    }
  }
  return next
}

/** Stale results from a previous workspace must never overwrite the new one. */
function isCurrentWorkspace(state: ExplorerState, workspaceId: number): boolean {
  return state.workspaceId === workspaceId
}

export function explorerReducer(state: ExplorerState, action: ExplorerAction): ExplorerState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialExplorerState(), workspaceId: action.workspaceId }
    case 'toggle': {
      if (state.expanded.includes(action.path)) {
        return {
          ...state,
          expanded: without(state.expanded, action.path),
          entries: withoutKey(state.entries, action.path),
          errors: withoutKey(state.errors, action.path)
        }
      }
      return { ...state, expanded: [...state.expanded, action.path] }
    }
    case 'directory-loading': {
      if (state.loading.includes(action.path)) {
        return state
      }
      return { ...state, loading: [...state.loading, action.path] }
    }
    case 'directory-loaded': {
      if (!isCurrentWorkspace(state, action.workspaceId)) {
        return state
      }
      return {
        ...state,
        loading: without(state.loading, action.path),
        entries: { ...state.entries, [action.path]: action.entries },
        errors: withoutKey(state.errors, action.path)
      }
    }
    case 'directory-failed': {
      return {
        ...state,
        loading: without(state.loading, action.path),
        errors: { ...state.errors, [action.path]: action.message }
      }
    }
    case 'file-selected': {
      return {
        ...state,
        selectedPath: action.path,
        preview: { path: action.path, content: null, loading: true, error: null, revision: null }
      }
    }
    case 'file-loaded': {
      if (!isCurrentWorkspace(state, action.workspaceId) || state.selectedPath !== action.path) {
        return state
      }
      return {
        ...state,
        preview: { path: action.path, content: action.content, loading: false, error: null, revision: action.revision }
      }
    }
    case 'file-failed': {
      if (state.selectedPath !== action.path) {
        return state
      }
      return {
        ...state,
        preview: { path: action.path, content: null, loading: false, error: action.message, revision: null }
      }
    }
  }
}
