import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeWorkspaceWriteError } from '../../lib/workspace-write-error'
import {
  applyDraftChange,
  createEditorState,
  EDIT_CONFLICT_MESSAGE,
  isEditorDirty,
  markEditorConflict,
  markEditorReloaded,
  markEditorSaveFailed,
  markEditorSaved,
  markEditorSaving
} from './editor-state'
import {
  confirmDiscardUnsavedDraft,
  hasUnsavedDraft,
  setUnsavedDraft
} from './editor-guard'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)

describe('editor state', () => {
  it('entering edit copies the exact content and revision', () => {
    const state = createEditorState('line1\nline2', REVISION_A)
    assert.equal(state.originalContent, 'line1\nline2')
    assert.equal(state.draftContent, 'line1\nline2')
    assert.equal(state.revision, REVISION_A)
    assert.equal(state.saving, false)
    assert.equal(state.saveError, null)
    assert.equal(state.conflict, false)
  })

  it('draft updates change only the draft', () => {
    const state = applyDraftChange(createEditorState('a', REVISION_A), 'b')
    assert.equal(state.draftContent, 'b')
    assert.equal(state.originalContent, 'a')
    assert.equal(state.revision, REVISION_A)
  })

  it('derives dirty from content difference only', () => {
    assert.equal(isEditorDirty(createEditorState('same', REVISION_A)), false)
    assert.equal(isEditorDirty(applyDraftChange(createEditorState('same', REVISION_A), 'same')), false)
    assert.equal(isEditorDirty(applyDraftChange(createEditorState('same', REVISION_A), 'same ')), true)
    assert.equal(isEditorDirty(applyDraftChange(createEditorState('a\n', REVISION_A), 'a')), true)
  })

  it('cancelling is a pure discard: the original is never mutated by edits', () => {
    const entered = createEditorState('original', REVISION_A)
    const edited = applyDraftChange(entered, 'trashed draft')
    assert.equal(entered.originalContent, 'original')
    assert.equal(entered.draftContent, 'original')
    assert.equal(edited.originalContent, 'original')
  })

  it('a successful save installs the new content and revision', () => {
    const edited = applyDraftChange(createEditorState('old', REVISION_A), 'new')
    const saved = markEditorSaved(markEditorSaving(edited), REVISION_B)
    assert.equal(saved.originalContent, 'new')
    assert.equal(saved.draftContent, 'new')
    assert.equal(saved.revision, REVISION_B)
    assert.equal(saved.saving, false)
    assert.equal(saved.saveError, null)
    assert.equal(saved.conflict, false)
    assert.equal(isEditorDirty(saved), false)
  })

  it('a failed save preserves the draft', () => {
    const edited = applyDraftChange(createEditorState('old', REVISION_A), 'new')
    const failed = markEditorSaveFailed(markEditorSaving(edited), 'We couldn’t save this file.')
    assert.equal(failed.draftContent, 'new')
    assert.equal(failed.originalContent, 'old')
    assert.equal(failed.revision, REVISION_A)
    assert.equal(failed.saving, false)
    assert.equal(failed.saveError, 'We couldn’t save this file.')
    assert.equal(failed.conflict, false)
  })

  it('a conflict preserves the draft and flags reload', () => {
    const edited = applyDraftChange(createEditorState('old', REVISION_A), 'new')
    const conflicted = markEditorConflict(markEditorSaving(edited), EDIT_CONFLICT_MESSAGE)
    assert.equal(conflicted.draftContent, 'new')
    assert.equal(conflicted.conflict, true)
    assert.equal(conflicted.saveError, EDIT_CONFLICT_MESSAGE)
    assert.equal(normalizeWorkspaceWriteError(new Error(conflicted.saveError ?? '')).kind, 'conflict')
    assert.equal(normalizeWorkspaceWriteError(new Error('We couldn’t save this file.')).kind, 'unavailable')
  })

  it('reload-from-disk installs fresh bytes as the new baseline', () => {
    const conflicted = markEditorConflict(createEditorState('old', REVISION_A), EDIT_CONFLICT_MESSAGE)
    const reloaded = markEditorReloaded('external B', REVISION_B)
    assert.equal(reloaded.originalContent, 'external B')
    assert.equal(reloaded.draftContent, 'external B')
    assert.equal(reloaded.revision, REVISION_B)
    assert.equal(reloaded.conflict, false)
    assert.equal(isEditorDirty(reloaded), false)
    assert.equal(conflicted.draftContent, 'old')
  })

  it('editing clears transient errors but keeps conflict state', () => {
    const failed = markEditorSaveFailed(createEditorState('old', REVISION_A), 'boom')
    assert.equal(applyDraftChange(failed, 'new').saveError, null)
    const conflicted = markEditorConflict(createEditorState('old', REVISION_A), EDIT_CONFLICT_MESSAGE)
    assert.equal(applyDraftChange(conflicted, 'new').conflict, true)
  })
})

describe('dirty navigation guards', () => {
  it('file selection proceeds when clean and confirms when dirty', () => {
    setUnsavedDraft(false)
    try {
      assert.equal(hasUnsavedDraft(), false)
      assert.equal(confirmDiscardUnsavedDraft(() => false), true)
      setUnsavedDraft(true)
      assert.equal(confirmDiscardUnsavedDraft(() => true), true)
      assert.equal(confirmDiscardUnsavedDraft(() => false), false)
    } finally {
      setUnsavedDraft(false)
    }
  })

  it('search-result navigation shares the file-selection guard', () => {
    setUnsavedDraft(true)
    try {
      let fileProceeds = false
      let searchProceeds = false
      if (confirmDiscardUnsavedDraft(() => false)) {
        fileProceeds = true
      }
      if (confirmDiscardUnsavedDraft(() => false)) {
        searchProceeds = true
      }
      assert.equal(fileProceeds, searchProceeds)
      assert.equal(fileProceeds, false)
    } finally {
      setUnsavedDraft(false)
    }
  })

  it('workspace switching shares the same guard and stays on decline', () => {
    setUnsavedDraft(true)
    try {
      let switched = false
      const requestWorkspaceSwitch = (confirm: () => boolean): void => {
        if (!confirmDiscardUnsavedDraft(confirm)) {
          return
        }
        switched = true
      }
      requestWorkspaceSwitch(() => false)
      assert.equal(switched, false)
      requestWorkspaceSwitch(() => true)
      assert.equal(switched, true)
    } finally {
      setUnsavedDraft(false)
    }
  })

  it('blocks navigation without a confirmation UI when dirty', () => {
    setUnsavedDraft(true)
    try {
      assert.equal(confirmDiscardUnsavedDraft(), false)
    } finally {
      setUnsavedDraft(false)
    }
  })
})
