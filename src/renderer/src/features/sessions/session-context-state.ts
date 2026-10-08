import type { SessionContextDraft } from '../../../../shared/context/types'

/**
 * Pure composer-draft state for explicit project context (no React
 * imports) so add/remove/preview/clear and workspace isolation are
 * unit-testable with the Node runner. Drafts are renderer-local until
 * send; the main process re-resolves file items from disk at send
 * time. No timers, no polling, no auto-attach lives here.
 */

export interface SessionContextDraftState {
  readonly workspaceId: number | null
  readonly drafts: readonly SessionContextDraft[]
  readonly error: string | null
}

export function initialSessionContextDraftState(): SessionContextDraftState {
  return { workspaceId: null, drafts: [], error: null }
}

export type SessionContextDraftAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'draft-added'; readonly workspaceId: number; readonly draft: SessionContextDraft }
  | { readonly type: 'draft-removed'; readonly workspaceId: number; readonly draftId: string }
  | { readonly type: 'drafts-cleared'; readonly workspaceId: number }
  | { readonly type: 'draft-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'draft-error-dismissed'; readonly workspaceId: number }

export function sessionContextDraftReducer(
  state: SessionContextDraftState,
  action: SessionContextDraftAction
): SessionContextDraftState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialSessionContextDraftState(), workspaceId: action.workspaceId }
    case 'draft-added': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      if (state.drafts.some((entry) => entry.draftId === action.draft.draftId)) {
        return state
      }
      return { ...state, drafts: [...state.drafts, action.draft], error: null }
    }
    case 'draft-removed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        drafts: state.drafts.filter((entry) => entry.draftId !== action.draftId)
      }
    }
    case 'drafts-cleared': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, drafts: [], error: null }
    }
    case 'draft-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, error: action.message }
    }
    case 'draft-error-dismissed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, error: null }
    }
  }
}
