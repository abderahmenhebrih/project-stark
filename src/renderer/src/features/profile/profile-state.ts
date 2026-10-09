import type { LocalProfile } from '../../../../shared/profile/types'

/**
 * Pure local-profile editor state (no React imports): draft editing,
 * explicit save with double-submit guard, and error handling are
 * unit-testable with the Node runner. This edits the LOCAL display
 * preference only ("STARK calls you") — never a cloud profile, never
 * synchronized to Supabase.
 */

export interface ProfileEditorState {
  readonly current: LocalProfile | null
  readonly draft: string
  readonly editing: boolean
  readonly saving: boolean
  readonly saveError: string | null
  readonly notice: string | null
}

export function initialProfileEditorState(current: LocalProfile | null): ProfileEditorState {
  return {
    current,
    draft: current?.displayName ?? '',
    editing: false,
    saving: false,
    saveError: null,
    notice: null
  }
}

export type ProfileEditorAction =
  | { readonly type: 'edit-started' }
  | { readonly type: 'edit-cancelled' }
  | { readonly type: 'draft-changed'; readonly draft: string }
  | { readonly type: 'save-started' }
  | { readonly type: 'save-succeeded'; readonly profile: LocalProfile }
  | { readonly type: 'save-failed'; readonly message: string }
  | { readonly type: 'notice-dismissed' }

export function profileEditorReducer(state: ProfileEditorState, action: ProfileEditorAction): ProfileEditorState {
  switch (action.type) {
    case 'edit-started':
      return { ...state, editing: true, draft: state.current?.displayName ?? '', saveError: null, notice: null }
    case 'edit-cancelled':
      if (state.saving) {
        return state
      }
      return { ...state, editing: false, draft: state.current?.displayName ?? '', saveError: null }
    case 'draft-changed':
      return { ...state, draft: action.draft }
    case 'save-started':
      if (state.saving) {
        return state
      }
      return { ...state, saving: true, saveError: null, notice: null }
    case 'save-succeeded':
      return {
        ...state,
        saving: false,
        editing: false,
        saveError: null,
        notice: 'Saved. STARK will call you this name.',
        current: action.profile,
        draft: action.profile.displayName
      }
    case 'save-failed':
      return { ...state, saving: false, saveError: action.message }
    case 'notice-dismissed':
      return { ...state, notice: null }
  }
}

/** Client-side non-empty check; main enforces the full Stage 4 rules. */
export function isProfileDraftSubmittable(draft: string): boolean {
  return draft.trim() !== ''
}
