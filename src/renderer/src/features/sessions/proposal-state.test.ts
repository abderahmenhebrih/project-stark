import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionContextDraft } from '../../../../shared/context/types'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import {
  initialProposalState,
  proposalEligibility,
  proposalReducer,
  type ProposalPanelState
} from './proposal-state'

function wholeFile(draftId = 'ctx-1'): SessionContextDraft {
  return {
    draftId,
    kind: 'whole-file',
    label: 'app.ts · whole file',
    relativePath: 'app.ts',
    lineStart: 1,
    lineEnd: 3,
    content: 'a\nb\nc\n',
    contentBytes: 6,
    sourceRevision: 'a'.repeat(64)
  }
}

function excerpt(draftId = 'ctx-2'): SessionContextDraft {
  return {
    draftId,
    kind: 'file-excerpt',
    label: 'app.ts · lines 1–1',
    relativePath: 'app.ts',
    lineStart: 1,
    lineEnd: 1,
    content: 'a\n',
    contentBytes: 2,
    sourceRevision: 'b'.repeat(64)
  }
}

function searchMatch(draftId = 'ctx-3'): SessionContextDraft {
  return {
    draftId,
    kind: 'search-match',
    label: 'app.ts · line 2',
    relativePath: 'app.ts',
    lineStart: 1,
    lineEnd: 3,
    content: 'a\nb\nc\n',
    contentBytes: 6,
    sourceRevision: 'c'.repeat(64)
  }
}

function note(draftId = 'ctx-4'): SessionContextDraft {
  return { draftId, kind: 'manual-note', label: 'Manual note', relativePath: null, lineStart: null, lineEnd: null, content: 'hi', contentBytes: 2 }
}

function fakeTransaction(id = 9): ChangeTransaction {
  return {
    id,
    workspaceId: 7,
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    appliedAt: null,
    rejectedAt: null,
    rolledBackAt: null,
    files: [
      {
        relativePath: 'app.ts',
        beforeRevision: 'a'.repeat(64),
        proposedRevision: 'b'.repeat(64),
        appliedRevision: null,
        beforeContent: 'a\n',
        proposedContent: 'b\n'
      }
    ]
  }
}

function bound(workspaceId = 7, sessionId = 3): ProposalPanelState {
  return { ...initialProposalState(), workspaceId, sessionId }
}

describe('proposal composer state', () => {
  it('defaults to Ask mode', () => {
    const state = initialProposalState()
    assert.equal(state.mode, 'ask')
    assert.equal(state.preparing, false)
    assert.equal(state.result, null)
    assert.equal(state.error, null)
  })

  it('switches to Propose without auto-starting', () => {
    let state = bound()
    state = proposalReducer(state, { type: 'mode-changed', workspaceId: 7, mode: 'propose' })
    assert.equal(state.mode, 'propose')
    assert.equal(state.preparing, false)
    assert.equal(state.result, null)
  })

  it('one whole-file context enables proposal', () => {
    assert.equal(proposalEligibility([wholeFile()]).eligible, true)
    assert.equal(proposalEligibility([wholeFile()]).kind, 'single')
    assert.equal(proposalEligibility([wholeFile(), note()]).eligible, true)
    assert.equal(proposalEligibility([wholeFile(), note()]).kind, 'single')
  })

  it('invalid context disables with guidance', () => {
    assert.deepEqual(proposalEligibility([]).reason, 'Attach one or more whole files to propose code changes.')
    assert.deepEqual(proposalEligibility([note()]).reason, 'Attach one or more whole files to propose code changes.')
    for (const drafts of [[excerpt()], [searchMatch()], [wholeFile(), excerpt()]] as const) {
      const outcome = proposalEligibility([...drafts])
      assert.equal(outcome.eligible, false)
      assert.equal(outcome.kind, 'none')
      assert.equal(outcome.reason, 'Code proposals require whole-file attachments only.')
    }
    const tooMany = Array.from({ length: 6 }, (_, index) => wholeFile(`ctx-${String(index)}`))
    const over = proposalEligibility(tooMany)
    assert.equal(over.eligible, false)
    assert.equal(over.reason, 'STARK can propose changes to at most 5 files at once.')
  })

  it('two to five whole files select the Change Set path', () => {
    for (const count of [2, 3, 5]) {
      const drafts = Array.from({ length: count }, (_, index) => wholeFile(`ctx-${String(index)}`))
      const outcome = proposalEligibility(drafts)
      assert.equal(outcome.eligible, true)
      assert.equal(outcome.kind, 'multi')
    }
  })

  it('preparing state tracks the proposal flight', () => {
    let state: ProposalPanelState = { ...bound(), mode: 'propose' as const }
    state = proposalReducer(state, { type: 'proposal-started', workspaceId: 7, sessionId: 3, kind: 'single' })
    assert.equal(state.preparing, true)
    assert.equal(state.activeKind, 'single')
    state = proposalReducer(
      state,
      { type: 'proposal-succeeded', workspaceId: 7, sessionId: 3, result: { transaction: fakeTransaction(), summary: 'bump' } }
    )
    assert.equal(state.preparing, false)
    assert.equal(state.result?.summary, 'bump')
  })

  it('success card carries transaction and summary for Review', () => {
    let state: ProposalPanelState = { ...bound(), mode: 'propose' as const, preparing: true }
    const transaction = fakeTransaction(12)
    state = proposalReducer(state, { type: 'proposal-succeeded', workspaceId: 7, sessionId: 3, result: { transaction, summary: 's' } })
    assert.equal(state.result?.transaction.id, 12)
    assert.equal(state.result?.transaction.status, 'pending')
  })

  it('Review callback is the transaction id (no path forging)', () => {
    const state: ProposalPanelState = {
      ...bound(),
      mode: 'propose',
      result: { transaction: fakeTransaction(12), summary: 's' }
    }
    // The panel calls onReviewTransaction(result.transaction.id): the
    // model never supplies a path, so nothing hostile can redirect it.
    assert.equal(state.result?.transaction.id, 12)
    assert.ok(!JSON.stringify(state.result).includes('..'))
  })

  it('failure retains user/history: only error is set, nothing cleared', () => {
    let state: ProposalPanelState = { ...bound(), mode: 'propose', preparing: true }
    state = proposalReducer(state, { type: 'proposal-failed', workspaceId: 7, sessionId: 3, message: 'boom' })
    assert.equal(state.preparing, false)
    assert.equal(state.error, 'boom')
    assert.equal(state.result, null)
    assert.equal(state.mode, 'propose')
  })

  it('explicit retry re-enters preparing without auto-retry', () => {
    let state: ProposalPanelState = { ...bound(), mode: 'propose', error: 'boom' }
    const before = state
    // No timer or effect retries: state only changes on explicit action.
    assert.equal(before.preparing, false)
    state = proposalReducer(state, { type: 'proposal-retried', workspaceId: 7, sessionId: 3 })
    assert.equal(state.preparing, true)
    assert.equal(state.error, null)
  })

  it('switching workspace clears transient proposal result', () => {
    const state: ProposalPanelState = {
      ...bound(),
      mode: 'propose',
      result: { transaction: fakeTransaction(), summary: 's' },
      error: 'e'
    }
    const next = proposalReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(next.workspaceId, 8)
    assert.equal(next.result, null)
    assert.equal(next.error, null)
    assert.equal(next.preparing, false)
  })

  it('switching session clears transient proposal result', () => {
    const state: ProposalPanelState = {
      ...bound(),
      mode: 'propose',
      result: { transaction: fakeTransaction(), summary: 's' },
      error: 'e'
    }
    const next = proposalReducer(state, { type: 'session-changed', workspaceId: 7, sessionId: 4 })
    assert.equal(next.sessionId, 4)
    assert.equal(next.result, null)
    assert.equal(next.error, null)
  })

  it('Ask mode never creates proposal state', () => {
    let state = bound()
    state = proposalReducer(state, { type: 'mode-changed', workspaceId: 7, mode: 'ask' })
    assert.equal(state.mode, 'ask')
    assert.equal(state.preparing, false)
    assert.equal(state.result, null)
    // Cross-session outcomes are ignored while in Ask.
    const ignored = proposalReducer(state, {
      type: 'proposal-succeeded',
      workspaceId: 7,
      sessionId: 999,
      result: { transaction: fakeTransaction(), summary: 's' }
    })
    assert.equal(ignored, state)
  })

  it('ignores cross-workspace and cross-session outcomes', () => {
    const state = { ...bound(), mode: 'propose' as const, preparing: true }
    assert.equal(proposalReducer(state, { type: 'proposal-started', workspaceId: 8, sessionId: 3, kind: 'single' }), state)
    assert.equal(
      proposalReducer(state, { type: 'proposal-failed', workspaceId: 7, sessionId: 4, message: 'x' }),
      state
    )
  })
})
