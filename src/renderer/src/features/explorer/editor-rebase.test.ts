import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDraftChange,
  canRequestReview,
  createEditorState,
  isEditorDirty,
  markEditorSaving,
  rebaseEditorOnExternalWrite
} from './editor-state'

/**
 * Hackathon stabilization (H1/H9): Accept/Rollback must refresh the
 * active editor base without destroying newer user input, and Ctrl+S
 * must stay single-flight with no direct write.
 */
describe('accept/rollback editor rebase', () => {
  it('clean editor becomes clean on the accepted bytes + revision', () => {
    const editor = createEditorState('old', 'rev-old')
    const rebased = rebaseEditorOnExternalWrite(editor, 'new', 'rev-new')
    assert.ok(rebased !== null)
    assert.equal(rebased.originalContent, 'new')
    assert.equal(rebased.draftContent, 'new')
    assert.equal(rebased.revision, 'rev-new')
    assert.equal(isEditorDirty(rebased), false)
    assert.equal(rebased.saving, false)
    assert.equal(rebased.conflict, false)
    assert.equal(rebased.saveError, null)
  })

  it('in-flight keystrokes survive the late accept response as draft on the new base', () => {
    const clean = createEditorState('old', 'rev-old')
    const typing = applyDraftChange(clean, 'old + keystrokes')
    const rebased = rebaseEditorOnExternalWrite(typing, 'accepted', 'rev-new')
    assert.ok(rebased !== null)
    // Newer user input wins over the late authoritative bytes for the
    // draft; the base still advances so the next Review compares
    // against the NEW revision instead of conflicting.
    assert.equal(rebased.draftContent, 'old + keystrokes')
    assert.equal(rebased.originalContent, 'accepted')
    assert.equal(rebased.revision, 'rev-new')
    assert.equal(isEditorDirty(rebased), true)
  })

  it('next edit after rebase starts from accepted bytes', () => {
    const editor = createEditorState('old', 'rev-old')
    const rebased = rebaseEditorOnExternalWrite(editor, 'accepted', 'rev-new')
    assert.ok(rebased !== null)
    const edited = applyDraftChange(rebased, 'accepted + more')
    assert.equal(edited.revision, 'rev-new')
    assert.equal(isEditorDirty(edited), true)
  })

  it('null (read-only preview) never gains an editable draft', () => {
    assert.equal(rebaseEditorOnExternalWrite(null, 'new', 'rev-new'), null)
  })

  it('rollback uses the same rebase path', () => {
    const editor = createEditorState('applied', 'rev-applied')
    const rebased = rebaseEditorOnExternalWrite(editor, 'before', 'rev-before')
    assert.ok(rebased !== null)
    assert.equal(rebased.originalContent, 'before')
    assert.equal(rebased.draftContent, 'before')
    assert.equal(rebased.revision, 'rev-before')
    assert.equal(isEditorDirty(rebased), false)
  })
})

describe('ctrl+s review single-flight', () => {
  it('clean editors cannot request review (no empty proposals)', () => {
    assert.equal(canRequestReview(createEditorState('same', 'rev')), false)
    assert.equal(canRequestReview(null), false)
  })

  it('dirty idle editors can request review exactly once until saving clears', () => {
    const dirty = applyDraftChange(createEditorState('a', 'rev'), 'b')
    assert.equal(canRequestReview(dirty), true)
    // In-flight proposal blocks a second Ctrl+S.
    assert.equal(canRequestReview(markEditorSaving(dirty)), false)
  })
})
