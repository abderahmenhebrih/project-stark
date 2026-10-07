import type {
  ChangeTransaction,
  ChangeTransactionStatus
} from '../../../../shared/change-transactions/types'

/**
 * Pure Changes review state (no React imports) so proposal, review,
 * accept/reject/rollback, and history transitions are unit-testable
 * with the Node runner. Feature-local only — never in AppProvider.
 *
 * A successfully created proposal is persisted data, not a volatile
 * draft: selecting history or switching detail views never needs the
 * editor discard guard, and workspace switches remount the owner.
 */

export type ChangesBusy = 'idle' | 'accepting' | 'rejecting' | 'rolling-back'

export interface ChangesState {
  readonly workspaceId: number | null
  readonly history: readonly ChangeTransaction[]
  readonly historyLoading: boolean
  readonly historyError: string | null
  readonly selectedId: number | null
  readonly detail: ChangeTransaction | null
  readonly detailLoading: boolean
  readonly detailError: string | null
  readonly busy: ChangesBusy
  readonly actionError: string | null
  readonly notice: string | null
}

export function initialChangesState(): ChangesState {
  return {
    workspaceId: null,
    history: [],
    historyLoading: false,
    historyError: null,
    selectedId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    busy: 'idle',
    actionError: null,
    notice: null
  }
}

export type ChangesAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'history-loading' }
  | {
      readonly type: 'history-loaded'
      readonly workspaceId: number
      readonly transactions: readonly ChangeTransaction[]
    }
  | { readonly type: 'history-failed'; readonly message: string }
  | { readonly type: 'review-opened'; readonly transaction: ChangeTransaction }
  | { readonly type: 'review-loading'; readonly transactionId: number }
  | {
      readonly type: 'review-loaded'
      readonly workspaceId: number
      readonly transaction: ChangeTransaction
    }
  | { readonly type: 'review-failed'; readonly message: string }
  | { readonly type: 'review-closed' }
  | { readonly type: 'action-started'; readonly action: Exclude<ChangesBusy, 'idle'> }
  | { readonly type: 'action-failed'; readonly message: string }
  | { readonly type: 'action-succeeded'; readonly transaction: ChangeTransaction; readonly notice: string | null }
  | { readonly type: 'notice-dismissed' }

/** Display label for a lifecycle status. */
export function statusLabel(status: ChangeTransactionStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending review'
    case 'applied':
      return 'Applied'
    case 'rejected':
      return 'Rejected'
    case 'rolled_back':
      return 'Rolled back'
  }
}

function replaceInHistory(
  history: readonly ChangeTransaction[],
  transaction: ChangeTransaction
): ChangeTransaction[] {
  return history.map((entry) => (entry.id === transaction.id ? transaction : entry))
}

/** Stale async results from a previous workspace never overwrite the new one. */
function isCurrentWorkspace(state: ChangesState, workspaceId: number): boolean {
  return state.workspaceId === workspaceId
}

export function changesReducer(state: ChangesState, action: ChangesAction): ChangesState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialChangesState(), workspaceId: action.workspaceId }
    case 'history-loading':
      return { ...state, historyLoading: true, historyError: null }
    case 'history-loaded': {
      if (!isCurrentWorkspace(state, action.workspaceId)) {
        return state
      }
      return { ...state, historyLoading: false, history: action.transactions, historyError: null }
    }
    case 'history-failed':
      return { ...state, historyLoading: false, historyError: action.message }
    case 'review-opened':
      return {
        ...state,
        selectedId: action.transaction.id,
        detail: action.transaction,
        detailLoading: false,
        detailError: null,
        busy: 'idle',
        actionError: null,
        notice: null
      }
    case 'review-loading':
      return {
        ...state,
        selectedId: action.transactionId,
        detail: null,
        detailLoading: true,
        detailError: null,
        busy: 'idle',
        actionError: null,
        notice: null
      }
    case 'review-loaded': {
      if (!isCurrentWorkspace(state, action.workspaceId) || state.selectedId !== action.transaction.id) {
        return state
      }
      return { ...state, detailLoading: false, detail: action.transaction, detailError: null }
    }
    case 'review-failed':
      return { ...state, detailLoading: false, detailError: action.message }
    case 'review-closed':
      return {
        ...state,
        selectedId: null,
        detail: null,
        detailLoading: false,
        detailError: null,
        busy: 'idle',
        actionError: null,
        notice: null
      }
    case 'action-started':
      return { ...state, busy: action.action, actionError: null, notice: null }
    case 'action-failed':
      return { ...state, busy: 'idle', actionError: action.message }
    case 'action-succeeded':
      return {
        ...state,
        busy: 'idle',
        actionError: null,
        notice: action.notice,
        detail: action.transaction,
        history: replaceInHistory(state.history, action.transaction)
      }
    case 'notice-dismissed':
      return { ...state, notice: null }
  }
}
