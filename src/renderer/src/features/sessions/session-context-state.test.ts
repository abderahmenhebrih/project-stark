import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionContextDraft } from '../../../../shared/context/types'
import {
  initialSessionContextDraftState,
  sessionContextDraftReducer,
  type SessionContextDraftState
} from './session-context-state'

function makeDraft(draftId: string, label = 'a.ts · lines 1–2'): SessionContextDraft {
  return {
    draftId,
    kind: 'file-excerpt',
    label,
    relativePath: 'a.ts',
    lineStart: 1,
    lineEnd: 2,
    content: 'const a = 1\n',
    contentBytes: 12,
    sourceRevision: 'a'.repeat(64)
  }
}

function activeWorkspace(workspaceId: number): SessionContextDraftState {
  return { ...initialSessionContextDraftState(), workspaceId }
}

describe('session context drafts', () => {
  it('starts empty', () => {
    const state = activeWorkspace(7)
    assert.deepEqual(state.drafts, [])
    assert.equal(state.error, null)
  })

  it('adds drafts without duplicates', () => {
    let state = activeWorkspace(7)
    const draft = makeDraft('ctx-1')
    state = sessionContextDraftReducer(state, { type: 'draft-added', workspaceId: 7, draft })
    assert.equal(state.drafts.length, 1)
    state = sessionContextDraftReducer(state, { type: 'draft-added', workspaceId: 7, draft })
    assert.equal(state.drafts.length, 1)
    state = sessionContextDraftReducer(state, { type: 'draft-added', workspaceId: 7, draft: makeDraft('ctx-2') })
    assert.equal(state.drafts.length, 2)
  })

  it('removes one draft and keeps the rest', () => {
    let state: SessionContextDraftState = {
      ...activeWorkspace(7),
      drafts: [makeDraft('ctx-1'), makeDraft('ctx-2')]
    }
    state = sessionContextDraftReducer(state, { type: 'draft-removed', workspaceId: 7, draftId: 'ctx-1' })
    assert.deepEqual(
      state.drafts.map((entry) => entry.draftId),
      ['ctx-2']
    )
  })

  it('clears all drafts on send success', () => {
    let state: SessionContextDraftState = {
      ...activeWorkspace(7),
      drafts: [makeDraft('ctx-1')],
      error: 'stale'
    }
    state = sessionContextDraftReducer(state, { type: 'drafts-cleared', workspaceId: 7 })
    assert.deepEqual(state.drafts, [])
    assert.equal(state.error, null)
  })

  it('records and dismisses prepare failures', () => {
    let state = activeWorkspace(7)
    state = sessionContextDraftReducer(state, {
      type: 'draft-failed',
      workspaceId: 7,
      message: 'We couldn’t attach this context.'
    })
    assert.equal(state.error, 'We couldn’t attach this context.')
    state = sessionContextDraftReducer(state, { type: 'draft-error-dismissed', workspaceId: 7 })
    assert.equal(state.error, null)
  })

  it('workspace switch clears drafts and errors', () => {
    let state: SessionContextDraftState = {
      ...activeWorkspace(7),
      drafts: [makeDraft('ctx-1')],
      error: 'boom'
    }
    state = sessionContextDraftReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(state.workspaceId, 8)
    assert.deepEqual(state.drafts, [])
    assert.equal(state.error, null)
  })

  it('ignores cross-workspace actions', () => {
    const state: SessionContextDraftState = { ...activeWorkspace(7), drafts: [makeDraft('ctx-1')] }
    assert.equal(
      sessionContextDraftReducer(state, { type: 'draft-removed', workspaceId: 8, draftId: 'ctx-1' }),
      state
    )
    assert.equal(
      sessionContextDraftReducer(state, { type: 'drafts-cleared', workspaceId: 8 }),
      state
    )
  })
})
