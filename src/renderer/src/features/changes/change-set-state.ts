import type { ChangeSet, ChangeSetStatus } from '../../../../shared/change-sets/types'

/**
 * Pure Change Set panel state (no React imports) so grouped-review
 * listing, selection, and workspace isolation are unit-testable with
 * the Node runner. Mirrors the changes pattern: stale and
 * cross-workspace results are rejected. No timers, no polling.
 */

export interface ChangeSetPanelState {
  readonly workspaceId: number | null
  readonly sets: readonly ChangeSet[]
  readonly setsLoading: boolean
  readonly setsError: string | null
  readonly selectedSetId: number | null
  readonly setDetail: ChangeSet | null
  readonly setDetailLoading: boolean
  readonly setDetailError: string | null
}

export function initialChangeSetPanelState(): ChangeSetPanelState {
  return {
    workspaceId: null,
    sets: [],
    setsLoading: false,
    setsError: null,
    selectedSetId: null,
    setDetail: null,
    setDetailLoading: false,
    setDetailError: null
  }
}

export type ChangeSetPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'sets-loading' }
  | { readonly type: 'sets-loaded'; readonly workspaceId: number; readonly sets: readonly ChangeSet[] }
  | { readonly type: 'sets-failed'; readonly message: string }
  | { readonly type: 'set-loading'; readonly changeSetId: number }
  | { readonly type: 'set-loaded'; readonly workspaceId: number; readonly changeSet: ChangeSet }
  | { readonly type: 'set-failed'; readonly message: string }
  | { readonly type: 'set-closed' }

/**
 * Derives group state from child transaction statuses — the same rule
 * as the main-process service. Never persisted.
 */
export function deriveChangeSetStatus(statuses: readonly ChangeSet['items'][number]['transaction']['status'][]): ChangeSetStatus {
  if (statuses.every((status) => status === 'pending')) {
    return 'pending'
  }
  if (statuses.some((status) => status === 'pending')) {
    return 'partially_resolved'
  }
  return 'resolved'
}

/** Display label for a derived group status. */
export function changeSetStatusLabel(status: ChangeSetStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending review'
    case 'partially_resolved':
      return 'Partially resolved'
    case 'resolved':
      return 'Resolved'
  }
}

export function changeSetDerivedStatus(changeSet: ChangeSet): ChangeSetStatus {
  return deriveChangeSetStatus(changeSet.items.map((item) => item.transaction.status))
}

export function changeSetPanelReducer(
  state: ChangeSetPanelState,
  action: ChangeSetPanelAction
): ChangeSetPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialChangeSetPanelState(), workspaceId: action.workspaceId }
    case 'sets-loading':
      return { ...state, setsLoading: true, setsError: null }
    case 'sets-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, setsLoading: false, sets: action.sets, setsError: null }
    }
    case 'sets-failed':
      return { ...state, setsLoading: false, setsError: action.message }
    case 'set-loading':
      return {
        ...state,
        selectedSetId: action.changeSetId,
        setDetail: null,
        setDetailLoading: true,
        setDetailError: null
      }
    case 'set-loaded': {
      if (state.workspaceId !== action.workspaceId || state.selectedSetId !== action.changeSet.id) {
        return state
      }
      return { ...state, setDetailLoading: false, setDetail: action.changeSet, setDetailError: null }
    }
    case 'set-failed':
      return { ...state, setDetailLoading: false, setDetailError: action.message }
    case 'set-closed':
      return { ...state, selectedSetId: null, setDetail: null, setDetailLoading: false, setDetailError: null }
  }
}
