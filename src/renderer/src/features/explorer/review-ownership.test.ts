import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { explorerReducer, initialExplorerState, type ExplorerState } from './explorer-state'
import { changesReducer, initialChangesState, type ChangesState } from '../changes/changes-state'
import { changeSetPanelReducer, initialChangeSetPanelState, type ChangeSetPanelState } from '../changes/change-set-state'
import { gitDiffReducer, initialGitDiffState, type GitDiffState } from '../git/git-state'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import type { ChangeSet } from '../../../../shared/change-sets/types'

/**
 * Hackathon stabilization (H2–H6): review ownership invariants at the
 * reducer level — the layer every Explorer async completion funnels
 * through. Background arrivals never yank the foreground file, stale
 * review arrivals never overwrite newer selections, and closing one
 * detail clears exactly its own presentation state.
 */
function transaction(id: number, workspaceId: number): ChangeTransaction {
  return {
    id,
    workspaceId,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    files: []
  } as unknown as ChangeTransaction
}

function changeSet(id: number, workspaceId: number): ChangeSet {
  return { id, workspaceId, items: [] } as unknown as ChangeSet
}

describe('review ownership (H2 background yank)', () => {
  it('file-loaded for a background path never replaces the foreground preview', () => {
    let state: ExplorerState = { ...initialExplorerState(), workspaceId: 7 }
    state = explorerReducer(state, { type: 'file-selected', path: 'a.ts' })
    state = explorerReducer(state, {
      type: 'file-loaded',
      workspaceId: 7,
      path: 'b.ts',
      content: 'background',
      revision: 'rev-b'
    })
    // Still loading a.ts; the background arrival is dropped.
    assert.equal(state.preview?.path, 'a.ts')
    assert.equal(state.preview?.content, null)
  })

  it('file-loaded for another workspace never overwrites the new one', () => {
    let state: ExplorerState = { ...initialExplorerState(), workspaceId: 7 }
    state = explorerReducer(state, { type: 'file-selected', path: 'a.ts' })
    state = explorerReducer(state, {
      type: 'file-loaded',
      workspaceId: 9,
      path: 'a.ts',
      content: 'stale',
      revision: 'rev-stale'
    })
    assert.equal(state.preview?.content, null)
  })
})

describe('review loading ownership (H4 stale requests)', () => {
  it('review-loaded for a superseded transaction id is rejected', () => {
    let state: ChangesState = { ...initialChangesState(), workspaceId: 3 }
    state = changesReducer(state, { type: 'review-loading', transactionId: 1 })
    state = changesReducer(state, { type: 'review-loading', transactionId: 2 })
    state = changesReducer(state, { type: 'review-loaded', workspaceId: 3, transaction: transaction(1, 3) })
    assert.equal(state.selectedId, 2)
    assert.equal(state.detail, null)
    assert.equal(state.detailLoading, true)
  })

  it('review-loaded from another workspace is rejected', () => {
    let state: ChangesState = { ...initialChangesState(), workspaceId: 3 }
    state = changesReducer(state, { type: 'review-loading', transactionId: 1 })
    state = changesReducer(state, { type: 'review-loaded', workspaceId: 4, transaction: transaction(1, 4) })
    assert.equal(state.detail, null)
    assert.equal(state.detailLoading, true)
  })

  it('set-loaded for a superseded set id is rejected', () => {
    let state: ChangeSetPanelState = { ...initialChangeSetPanelState(), workspaceId: 3 }
    state = changeSetPanelReducer(state, { type: 'set-loading', changeSetId: 1 })
    state = changeSetPanelReducer(state, { type: 'set-loading', changeSetId: 2 })
    state = changeSetPanelReducer(state, { type: 'set-loaded', workspaceId: 3, changeSet: changeSet(1, 3) })
    assert.equal(state.selectedSetId, 2)
    assert.equal(state.setDetail, null)
  })

  it('closing review clears loading so no spinner can stick', () => {
    let state: ChangesState = { ...initialChangesState(), workspaceId: 3 }
    state = changesReducer(state, { type: 'review-loading', transactionId: 1 })
    state = changesReducer(state, { type: 'review-closed' })
    assert.equal(state.detailLoading, false)
    assert.equal(state.selectedId, null)
    assert.equal(state.detailError, null)
  })
})

describe('secondary detail normalization (H5/H6)', () => {
  it('review-closed clears exactly the transaction detail', () => {
    let state: ChangesState = { ...initialChangesState(), workspaceId: 3 }
    state = changesReducer(state, { type: 'review-opened', transaction: transaction(1, 3) })
    state = changesReducer(state, { type: 'review-closed' })
    assert.equal(state.detail, null)
    assert.equal(state.selectedId, null)
    assert.equal(state.busy, 'idle')
  })

  it('set-closed clears exactly the set detail', () => {
    let state: ChangeSetPanelState = { ...initialChangeSetPanelState(), workspaceId: 3 }
    state = changeSetPanelReducer(state, { type: 'set-loading', changeSetId: 5 })
    state = changeSetPanelReducer(state, { type: 'set-loaded', workspaceId: 3, changeSet: changeSet(5, 3) })
    assert.ok(state.setDetail !== null)
    state = changeSetPanelReducer(state, { type: 'set-closed' })
    assert.equal(state.setDetail, null)
    assert.equal(state.selectedSetId, null)
  })

  it('diff-closed clears exactly the git diff', () => {
    let state: GitDiffState = { ...initialGitDiffState(), workspaceId: 3 }
    state = gitDiffReducer(state, {
      type: 'diff-loading',
      workspaceId: 3,
      relativePath: 'a.ts',
      target: 'unstaged',
      requestId: 1
    })
    assert.ok(state.relativePath !== null)
    state = gitDiffReducer(state, { type: 'diff-closed' })
    assert.equal(state.relativePath, null)
    assert.equal(state.phase, 'idle')
  })

  it('action-succeeded refreshes the visible detail so status never goes stale', () => {
    let state: ChangesState = { ...initialChangesState(), workspaceId: 3 }
    state = changesReducer(state, { type: 'review-opened', transaction: transaction(1, 3) })
    const applied = { ...transaction(1, 3), status: 'applied' } as ChangeTransaction
    state = changesReducer(state, { type: 'action-succeeded', transaction: applied, notice: 'Change applied' })
    assert.equal(state.detail?.status, 'applied')
  })
})
