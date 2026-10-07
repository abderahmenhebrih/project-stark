/**
 * Pure Stage 8 editor state (no React imports) so edit/dirty/conflict
 * transitions are unit-testable with the Node runner. Feature-local
 * only — never stored in the global AppProvider.
 *
 * dirty is always derived: draftContent !== originalContent.
 */

export interface EditorState {
  readonly originalContent: string
  readonly draftContent: string
  readonly revision: string
  readonly saving: boolean
  readonly saveError: string | null
  readonly conflict: boolean
}

/** Stable conflict copy used by editor-state tests. */
export const EDIT_CONFLICT_MESSAGE = 'This file changed on disk. Reload it before saving your changes.'

/** Enter edit mode with the exact content just read. */
export function createEditorState(content: string, revision: string): EditorState {
  return {
    originalContent: content,
    draftContent: content,
    revision,
    saving: false,
    saveError: null,
    conflict: false
  }
}

/** Keystroke update. A transient (non-conflict) error clears on edit. */
export function applyDraftChange(state: EditorState, draft: string): EditorState {
  return {
    ...state,
    draftContent: draft,
    saveError: state.conflict ? state.saveError : null
  }
}

/** Derived only — never stored. */
export function isEditorDirty(state: EditorState): boolean {
  return state.draftContent !== state.originalContent
}

export function markEditorSaving(state: EditorState): EditorState {
  return { ...state, saving: true, saveError: null, conflict: false }
}

/**
 * Success installs the submitted draft as the new clean baseline under
 * the returned revision.
 */
export function markEditorSaved(state: EditorState, revision: string): EditorState {
  return {
    originalContent: state.draftContent,
    draftContent: state.draftContent,
    revision,
    saving: false,
    saveError: null,
    conflict: false
  }
}

export function markEditorSaveFailed(state: EditorState, message: string): EditorState {
  return { ...state, saving: false, saveError: message }
}

/** Stale revision: the user's draft stays intact for review/reload. */
export function markEditorConflict(state: EditorState, message: string): EditorState {
  return { ...state, saving: false, saveError: message, conflict: true }
}

/** Reload-from-disk installs fresh bytes; the stale draft is replaced. */
export function markEditorReloaded(content: string, revision: string): EditorState {
  return {
    originalContent: content,
    draftContent: content,
    revision,
    saving: false,
    saveError: null,
    conflict: false
  }
}
