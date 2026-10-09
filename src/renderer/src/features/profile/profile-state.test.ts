import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  initialProfileEditorState,
  isProfileDraftSubmittable,
  profileEditorReducer
} from './profile-state'

describe('local profile editor', () => {
  it('starts from the current local name with no cloud implication', () => {
    const state = initialProfileEditorState({ displayName: 'Abdou' })
    assert.equal(state.draft, 'Abdou')
    assert.equal(state.editing, false)
    assert.equal(state.saving, false)
    const serialized = JSON.stringify(state)
    assert.ok(!serialized.includes('cloudUserId'))
    assert.ok(!serialized.includes('accessToken'))
  })

  it('ignores double submits while a save is in flight', () => {
    let state = initialProfileEditorState({ displayName: 'Abdou' })
    state = profileEditorReducer(state, { type: 'edit-started' })
    state = profileEditorReducer(state, { type: 'save-started' })
    const again = profileEditorReducer(state, { type: 'save-started' })
    assert.equal(again, state)
    const cancelled = profileEditorReducer(state, { type: 'edit-cancelled' })
    assert.equal(cancelled, state)
  })

  it('saves locally without touching cloud identity', () => {
    let state = initialProfileEditorState({ displayName: 'Abdou' })
    state = profileEditorReducer(state, { type: 'edit-started' })
    state = profileEditorReducer(state, { type: 'draft-changed', draft: 'Amina' })
    state = profileEditorReducer(state, { type: 'save-started' })
    state = profileEditorReducer(state, { type: 'save-succeeded', profile: { displayName: 'Amina' } })
    assert.equal(state.current?.displayName, 'Amina')
    assert.equal(state.editing, false)
    assert.ok(state.notice !== null)
  })

  it('keeps the draft on save failure for correction', () => {
    let state = initialProfileEditorState({ displayName: 'Abdou' })
    state = profileEditorReducer(state, { type: 'edit-started' })
    state = profileEditorReducer(state, { type: 'draft-changed', draft: 'Amina' })
    state = profileEditorReducer(state, { type: 'save-started' })
    state = profileEditorReducer(state, { type: 'save-failed', message: 'We couldn’t save your name.' })
    assert.equal(state.draft, 'Amina')
    assert.equal(state.current?.displayName, 'Abdou')
  })

  it('rejects blank drafts client-side; main enforces Stage 4 rules', () => {
    assert.equal(isProfileDraftSubmittable('  '), false)
    assert.equal(isProfileDraftSubmittable('Abdou'), true)
  })
})
