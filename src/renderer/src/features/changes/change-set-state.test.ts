import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangeSet } from '../../../../shared/change-sets/types'
import {
  changeSetDerivedStatus,
  changeSetPanelReducer,
  changeSetStatusLabel,
  deriveChangeSetStatus,
  initialChangeSetPanelState,
  type ChangeSetPanelState
} from './change-set-state'

function fakeSet(id: number, statuses: readonly ('pending' | 'applied' | 'rejected' | 'rolled_back')[]): ChangeSet {
  return {
    id,
    workspaceId: 7,
    kind: 'ai_multi_file_proposal',
    summary: `set ${String(id)}`,
    createdAt: 1000 + id,
    updatedAt: 1000 + id,
    items: statuses.map((status, index) => ({
      ordinal: index,
      transaction: {
        id: id * 10 + index,
        workspaceId: 7,
        status,
        createdAt: 1000,
        updatedAt: 1000,
        appliedAt: null,
        rejectedAt: null,
        rolledBackAt: null,
        files: [
          {
            relativePath: `f${String(index)}.ts`,
            beforeRevision: 'a'.repeat(64),
            proposedRevision: 'b'.repeat(64),
            appliedRevision: null,
            beforeContent: 'a\n',
            proposedContent: 'b\n'
          }
        ]
      },
      fileSummary: `file ${String(index)}`
    }))
  }
}

describe('change set panel state', () => {
  it('derives pending, partially_resolved, and resolved', () => {
    assert.equal(deriveChangeSetStatus(['pending', 'pending']), 'pending')
    assert.equal(deriveChangeSetStatus(['pending', 'applied', 'rejected']), 'partially_resolved')
    assert.equal(deriveChangeSetStatus(['applied', 'rejected', 'rolled_back']), 'resolved')
    assert.equal(changeSetDerivedStatus(fakeSet(1, ['pending', 'pending'])), 'pending')
    assert.equal(changeSetDerivedStatus(fakeSet(2, ['applied', 'pending'])), 'partially_resolved')
    assert.equal(changeSetDerivedStatus(fakeSet(3, ['applied', 'rejected'])), 'resolved')
  })

  it('labels derived states without an Accept All concept', () => {
    assert.equal(changeSetStatusLabel('pending'), 'Pending review')
    assert.equal(changeSetStatusLabel('partially_resolved'), 'Partially resolved')
    assert.equal(changeSetStatusLabel('resolved'), 'Resolved')
  })

  it('loads sets newest-first for the workspace only', () => {
    let state: ChangeSetPanelState = { ...initialChangeSetPanelState(), workspaceId: 7 }
    state = changeSetPanelReducer(state, { type: 'sets-loading' })
    assert.equal(state.setsLoading, true)
    state = changeSetPanelReducer(state, { type: 'sets-loaded', workspaceId: 7, sets: [fakeSet(2, ['pending']), fakeSet(1, ['applied'])] })
    assert.equal(state.setsLoading, false)
    assert.deepEqual(state.sets.map((entry) => entry.id), [2, 1])
    const stale = changeSetPanelReducer(state, { type: 'sets-loaded', workspaceId: 8, sets: [] })
    assert.equal(stale, state)
  })

  it('selects a set and loads its detail', () => {
    let state: ChangeSetPanelState = { ...initialChangeSetPanelState(), workspaceId: 7 }
    state = changeSetPanelReducer(state, { type: 'set-loading', changeSetId: 9 })
    assert.equal(state.selectedSetId, 9)
    assert.equal(state.setDetailLoading, true)
    state = changeSetPanelReducer(state, { type: 'set-loaded', workspaceId: 7, changeSet: fakeSet(9, ['pending']) })
    assert.equal(state.setDetail?.id, 9)
    state = changeSetPanelReducer(state, { type: 'set-closed' })
    assert.equal(state.setDetail, null)
    assert.equal(state.selectedSetId, null)
  })

  it('records and keeps set failures', () => {
    let state: ChangeSetPanelState = { ...initialChangeSetPanelState(), workspaceId: 7 }
    state = changeSetPanelReducer(state, { type: 'sets-failed', message: 'We couldn’t load change sets.' })
    assert.equal(state.setsError, 'We couldn’t load change sets.')
  })

  it('workspace switch clears sets and selection', () => {
    const state: ChangeSetPanelState = {
      ...initialChangeSetPanelState(),
      workspaceId: 7,
      sets: [fakeSet(1, ['pending'])],
      selectedSetId: 1,
      setDetail: fakeSet(1, ['pending'])
    }
    const next = changeSetPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(next.workspaceId, 8)
    assert.deepEqual(next.sets, [])
    assert.equal(next.setDetail, null)
  })
})
