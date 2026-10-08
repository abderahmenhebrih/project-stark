import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangeSet } from '../../../../shared/change-sets/types'
import {
  initialProposalState,
  proposalReducer,
  type ProposalPanelState
} from './proposal-state'

function fakeChangeSet(id = 5): ChangeSet {
  return {
    id,
    workspaceId: 7,
    kind: 'ai_multi_file_proposal',
    summary: 'grouped update',
    createdAt: 1000,
    updatedAt: 1000,
    items: [
      {
        ordinal: 0,
        transaction: {
          id: 50,
          workspaceId: 7,
          status: 'pending',
          createdAt: 1000,
          updatedAt: 1000,
          appliedAt: null,
          rejectedAt: null,
          rolledBackAt: null,
          files: [
            {
              relativePath: 'a.ts',
              beforeRevision: 'a'.repeat(64),
              proposedRevision: 'b'.repeat(64),
              appliedRevision: null,
              beforeContent: 'a\n',
              proposedContent: 'b\n'
            }
          ]
        },
        fileSummary: 'bump a'
      },
      {
        ordinal: 1,
        transaction: {
          id: 51,
          workspaceId: 7,
          status: 'pending',
          createdAt: 1000,
          updatedAt: 1000,
          appliedAt: null,
          rejectedAt: null,
          rolledBackAt: null,
          files: [
            {
              relativePath: 'b.ts',
              beforeRevision: 'c'.repeat(64),
              proposedRevision: 'd'.repeat(64),
              appliedRevision: null,
              beforeContent: 'c\n',
              proposedContent: 'd\n'
            }
          ]
        },
        fileSummary: 'bump b'
      }
    ]
  }
}

function boundPropose(): ProposalPanelState {
  return { ...initialProposalState(), workspaceId: 7, sessionId: 3, mode: 'propose' }
}

describe('proposal change-set results', () => {
  it('multi flight records its kind for explicit retry', () => {
    let state = boundPropose()
    state = proposalReducer(state, { type: 'proposal-started', workspaceId: 7, sessionId: 3, kind: 'multi' })
    assert.equal(state.preparing, true)
    assert.equal(state.activeKind, 'multi')
  })

  it('change-set success stores the set for the Review change set card', () => {
    let state: ProposalPanelState = { ...boundPropose(), preparing: true, activeKind: 'multi' }
    state = proposalReducer(state, { type: 'change-set-succeeded', workspaceId: 7, sessionId: 3, changeSet: fakeChangeSet() })
    assert.equal(state.preparing, false)
    assert.equal(state.changeSet?.changeSet.id, 5)
    assert.equal(state.changeSet?.changeSet.items.length, 2)
    assert.equal(state.result, null)
  })

  it('single and set results never coexist', () => {
    let state: ProposalPanelState = { ...boundPropose(), preparing: true, activeKind: 'multi' }
    state = proposalReducer(state, { type: 'change-set-succeeded', workspaceId: 7, sessionId: 3, changeSet: fakeChangeSet() })
    state = proposalReducer(state, { type: 'proposal-retried', workspaceId: 7, sessionId: 3 })
    assert.equal(state.changeSet, null)
    assert.equal(state.preparing, true)
  })

  it('failure clears both results and keeps the attempted kind', () => {
    let state: ProposalPanelState = { ...boundPropose(), preparing: true, activeKind: 'multi' }
    state = proposalReducer(state, { type: 'proposal-failed', workspaceId: 7, sessionId: 3, message: 'boom' })
    assert.equal(state.error, 'boom')
    assert.equal(state.changeSet, null)
    assert.equal(state.result, null)
    assert.equal(state.activeKind, 'multi')
  })

  it('workspace and session resets clear the change set', () => {
    const withSet: ProposalPanelState = {
      ...boundPropose(),
      changeSet: { changeSet: fakeChangeSet() }
    }
    assert.equal(proposalReducer(withSet, { type: 'workspace-changed', workspaceId: 8 }).changeSet, null)
    assert.equal(
      proposalReducer(withSet, { type: 'session-changed', workspaceId: 7, sessionId: 4 }).changeSet,
      null
    )
  })

  it('ignores cross-session change-set outcomes', () => {
    const state: ProposalPanelState = { ...boundPropose(), preparing: true, activeKind: 'multi' }
    assert.equal(
      proposalReducer(state, { type: 'change-set-succeeded', workspaceId: 7, sessionId: 9, changeSet: fakeChangeSet() }),
      state
    )
  })

  it('dismiss clears the change set without retrying', () => {
    const state: ProposalPanelState = { ...boundPropose(), changeSet: { changeSet: fakeChangeSet() } }
    const next = proposalReducer(state, { type: 'proposal-dismissed', workspaceId: 7, sessionId: 3 })
    assert.equal(next.changeSet, null)
    assert.equal(next.preparing, false)
  })
})
