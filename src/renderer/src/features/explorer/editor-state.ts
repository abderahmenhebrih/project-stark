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

/**
 * Whether a Ctrl+S-style gesture may open the Review flow: dirty,
 * idle, and present. Clean or in-flight editors safely no-op instead
 * of creating duplicate proposals (H9 single-flight).
 */
export function canRequestReview(state: EditorState | null): boolean {
  return state !== null && !state.saving && state.draftContent !== state.originalContent
}

/**
 * Rebase after an authoritative external write (Accept/Rollback, H1):
 * the accepted/rolled-back bytes + revision become the clean base. A
 * clean editor stays clean on the new bytes; keystrokes typed while
 * the write was in flight are preserved as the draft against the new
 * base so a late response never destroys newer user input. Null stays
 * null (read-only previews never gain an editable draft here).
 */
export function rebaseEditorOnExternalWrite(
  current: EditorState | null,
  content: string,
  revision: string
): EditorState | null {
  if (current === null) {
    return current
  }
  const dirty = current.draftContent !== current.originalContent
  return {
    originalContent: content,
    draftContent: dirty ? current.draftContent : content,
    revision,
    saving: false,
    saveError: null,
    conflict: false
  }
}
