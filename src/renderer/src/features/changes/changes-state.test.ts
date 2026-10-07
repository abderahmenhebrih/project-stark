import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import { changesReducer, initialChangesState, statusLabel } from './changes-state'

const REVISION_A = 'a'.repeat(64)
const REVISION_B = 'b'.repeat(64)

function pendingTransaction(id: number, workspaceId: number, path: string): ChangeTransaction {
  return {
    id,
    workspaceId,
    status: 'pending',
    createdAt: 1000 + id,
    updatedAt: 1000 + id,
    appliedAt: null,
    rejectedAt: null,
    rolledBackAt: null,
    files: [
      {
        relativePath: path,
        beforeRevision: REVISION_A,
        proposedRevision: REVISION_B,
        appliedRevision: null,
        beforeContent: 'before\n',
        proposedContent: 'after\n'
      }
    ]
  }
}

function withStatus(transaction: ChangeTransaction, status: ChangeTransaction['status']): ChangeTransaction {
  return { ...transaction, status }
}

describe('changes state', () => {
  it('labels every lifecycle status', () => {
    assert.equal(statusLabel('pending'), 'Pending review')
    assert.equal(statusLabel('applied'), 'Applied')
    assert.equal(statusLabel('rejected'), 'Rejected')
    assert.equal(statusLabel('rolled_back'), 'Rolled back')
  })

  it('changing workspace clears history and review detail', () => {
    const start = { ...initialChangesState(), workspaceId: 4 }
    const loaded = changesReducer(start, {
      type: 'history-loaded',
      workspaceId: 4,
      transactions: [pendingTransaction(1, 4, 'a.txt')]
    })
    const opened = changesReducer(loaded, { type: 'review-opened', transaction: pendingTransaction(1, 4, 'a.txt') })
    const next = changesReducer(opened, { type: 'workspace-changed', workspaceId: 7 })
    assert.equal(next.workspaceId, 7)
    assert.deepEqual(next.history, [])
    assert.equal(next.selectedId, null)
    assert.equal(next.detail, null)
    assert.equal(next.busy, 'idle')
  })

  it('loads history newest-first and ignores stale workspaces', () => {
    const start = { ...initialChangesState(), workspaceId: 7 }
    const stale = changesReducer(start, {
      type: 'history-loaded',
      workspaceId: 4,
      transactions: [pendingTransaction(9, 4, 'old.txt')]
    })
    assert.deepEqual(stale.history, [])
    const current = changesReducer(stale, {
      type: 'history-loaded',
      workspaceId: 7,
      transactions: [pendingTransaction(2, 7, 'b.txt'), pendingTransaction(1, 7, 'a.txt')]
    })
    assert.deepEqual(
      current.history.map((entry) => entry.id),
      [2, 1]
    )
    const failed = changesReducer(start, { type: 'history-failed', message: 'We couldn’t update this change.' })
    assert.equal(failed.historyError, 'We couldn’t update this change.')
    assert.equal(failed.historyLoading, false)
  })

  it('opening a created proposal enters pending review without implying a save', () => {
    const start = { ...initialChangesState(), workspaceId: 4 }
    const proposal = pendingTransaction(1, 4, 'a.txt')
    const opened = changesReducer(start, { type: 'review-opened', transaction: proposal })
    assert.equal(opened.selectedId, 1)
    assert.equal(opened.detail?.status, 'pending')
    // Proposal creation carries no disk effect: the reducer records no
    // applied revision and no notice of application.
    assert.equal(opened.detail?.files[0]?.appliedRevision, null)
    assert.equal(opened.notice, null)
  })

  it('accept moves the review to applied with a notice and history update', () => {
    const proposal = pendingTransaction(1, 4, 'a.txt')
    const start = changesReducer(
      changesReducer(
        { ...initialChangesState(), workspaceId: 4 },
        { type: 'history-loaded', workspaceId: 4, transactions: [proposal] }
      ),
      { type: 'review-opened', transaction: proposal }
    )
    const accepting = changesReducer(start, { type: 'action-started', action: 'accepting' })
    assert.equal(accepting.busy, 'accepting')
    const applied = withStatus({ ...proposal, files: [{ ...proposal.files[0]!, appliedRevision: REVISION_B }] }, 'applied')
    const done = changesReducer(accepting, { type: 'action-succeeded', transaction: applied, notice: 'Change applied' })
    assert.equal(done.busy, 'idle')
    assert.equal(done.detail?.status, 'applied')
    assert.equal(done.notice, 'Change applied')
    assert.equal(done.history[0]?.status, 'applied')
  })

  it('reject moves the review to rejected', () => {
    const proposal = pendingTransaction(1, 4, 'a.txt')
    const start = changesReducer({ ...initialChangesState(), workspaceId: 4 }, { type: 'review-opened', transaction: proposal })
    const done = changesReducer(
      changesReducer(start, { type: 'action-started', action: 'rejecting' }),
      { type: 'action-succeeded', transaction: withStatus(proposal, 'rejected'), notice: null }
    )
    assert.equal(done.detail?.status, 'rejected')
    assert.equal(done.notice, null)
  })

  it('rollback moves an applied review to rolled back', () => {
    const applied = withStatus(pendingTransaction(1, 4, 'a.txt'), 'applied')
    const start = changesReducer({ ...initialChangesState(), workspaceId: 4 }, { type: 'review-opened', transaction: applied })
    const done = changesReducer(
      changesReducer(start, { type: 'action-started', action: 'rolling-back' }),
      { type: 'action-succeeded', transaction: withStatus(applied, 'rolled_back'), notice: 'Change rolled back' }
    )
    assert.equal(done.detail?.status, 'rolled_back')
    assert.equal(done.notice, 'Change rolled back')
  })

  it('conflict failures keep the transaction state and record canonical copy', () => {
    const proposal = pendingTransaction(1, 4, 'a.txt')
    const start = changesReducer({ ...initialChangesState(), workspaceId: 4 }, { type: 'review-opened', transaction: proposal })
    const failed = changesReducer(
      changesReducer(start, { type: 'action-started', action: 'accepting' }),
      { type: 'action-failed', message: 'This file changed on disk. Reload it before saving your changes.' }
    )
    assert.equal(failed.busy, 'idle')
    assert.equal(failed.detail?.status, 'pending')
    assert.equal(failed.actionError, 'This file changed on disk. Reload it before saving your changes.')
  })

  it('restart-loaded pending transactions open for review directly', () => {
    // History reloaded after restart carries the persisted pending row.
    const persisted = pendingTransaction(3, 4, 'a.txt')
    const state = changesReducer(
      { ...initialChangesState(), workspaceId: 4 },
      { type: 'history-loaded', workspaceId: 4, transactions: [persisted] }
    )
    const reopened = changesReducer(state, { type: 'review-opened', transaction: persisted })
    assert.equal(reopened.detail?.status, 'pending')
    assert.equal(reopened.detail?.files[0]?.beforeContent, 'before\n')
    assert.equal(reopened.detail?.files[0]?.proposedContent, 'after\n')
  })

  it('closing a review clears detail but keeps history', () => {
    const proposal = pendingTransaction(1, 4, 'a.txt')
    const start = changesReducer(
      changesReducer(
        { ...initialChangesState(), workspaceId: 4 },
        { type: 'history-loaded', workspaceId: 4, transactions: [proposal] }
      ),
      { type: 'review-opened', transaction: proposal }
    )
    const closed = changesReducer(start, { type: 'review-closed' })
    assert.equal(closed.detail, null)
    assert.equal(closed.selectedId, null)
    assert.equal(closed.history.length, 1)
  })
})
