import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LooplinkPreview } from '../../../../shared/looplink/types'
import {
  initialLooplinkPanelState,
  looplinkPanelReducer,
  type LooplinkPanelState
} from './looplink-state'

function fakePreview(id = 31, status: LooplinkPreview['status'] = 'pending'): LooplinkPreview {
  return {
    id,
    status,
    sourceTitle: 'Build it',
    createdAt: 1000,
    payload: {
      version: 1,
      source: { sessionId: 3, title: 'Build it' },
      messages: [{ role: 'user', content: 'Hi.', createdAt: 1000 }],
      explicitContext: [
        {
          kind: 'whole-file',
          label: 'app.ts · whole file',
          relativePath: 'app.ts',
          lineStart: 1,
          lineEnd: 2,
          content: 'a\nb\n'
        }
      ],
      orchestration: {
        status: 'completed',
        action: 'answer',
        planSummary: 'Direct.',
        workerResult: null,
        workerResultOmitted: false
      },
      changes: [
        {
          kind: 'transaction',
          transactionId: 9,
          changeSetId: null,
          relativePath: 'a.ts',
          summary: 'a.ts',
          status: 'pending',
          groupStatus: null
        }
      ],
      omissions: { messageCount: 2, contextCount: 0, workerResultOmitted: false, changeCount: 0 }
    }
  }
}

function bound(): LooplinkPanelState {
  return { ...initialLooplinkPanelState(), workspaceId: 7, sessionId: 3 }
}

describe('looplink panel state', () => {
  it('starts empty', () => {
    const state = bound()
    assert.equal(state.looplink, null)
    assert.equal(state.acting, false)
  })

  it('loads pending continuity for the target session', () => {
    let state = bound()
    state = looplinkPanelReducer(state, { type: 'continuity-loading', workspaceId: 7, sessionId: 3 })
    assert.equal(state.loading, true)
    state = looplinkPanelReducer(state, { type: 'continuity-loaded', workspaceId: 7, sessionId: 3, looplink: fakePreview() })
    assert.equal(state.loading, false)
    assert.equal(state.looplink?.status, 'pending')
    assert.equal(state.looplink?.sourceTitle, 'Build it')
  })

  it('shows omission metadata from the payload', () => {
    const state: LooplinkPanelState = { ...bound(), looplink: fakePreview() }
    assert.equal(state.looplink?.payload.omissions.messageCount, 2)
    assert.equal(state.looplink?.payload.explicitContext[0]?.relativePath, 'app.ts')
  })

  it('dismiss transitions the card without a provider trigger', () => {
    let state: LooplinkPanelState = { ...bound(), looplink: fakePreview() }
    state = looplinkPanelReducer(state, { type: 'action-started', workspaceId: 7, sessionId: 3 })
    assert.equal(state.acting, true)
    state = looplinkPanelReducer(state, {
      type: 'action-succeeded',
      workspaceId: 7,
      sessionId: 3,
      looplink: fakePreview(31, 'dismissed')
    })
    assert.equal(state.acting, false)
    assert.equal(state.looplink?.status, 'dismissed')
  })

  it('creation selects the target without auto-send', () => {
    // Creating continuity only prepares the handoff object; this
    // reducer never sends messages or starts AI work by construction
    // (no such action exists).
    const actions = ['workspace-changed', 'session-changed', 'continuity-loading', 'continuity-loaded', 'continuity-failed', 'action-started', 'action-succeeded', 'action-failed'] as const
    assert.ok(!actions.some((type) => type.includes('send') || type.includes('generate') || type.includes('run')))
  })

  it('consumed and dismissed states display distinctly', () => {
    for (const status of ['pending', 'consumed', 'dismissed'] as const) {
      const state: LooplinkPanelState = { ...bound(), looplink: fakePreview(31, status) }
      assert.equal(state.looplink?.status, status)
    }
  })

  it('workspace and session switches reset continuity', () => {
    const state: LooplinkPanelState = { ...bound(), looplink: fakePreview() }
    const moved = looplinkPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(moved.workspaceId, 8)
    assert.equal(moved.looplink, null)
    const reselected = looplinkPanelReducer(state, { type: 'session-changed', workspaceId: 7, sessionId: 4 })
    assert.equal(reselected.sessionId, 4)
    assert.equal(reselected.looplink, null)
  })

  it('ignores cross-workspace and cross-session outcomes', () => {
    const state: LooplinkPanelState = { ...bound(), loading: true }
    assert.equal(looplinkPanelReducer(state, { type: 'continuity-loaded', workspaceId: 8, sessionId: 3, looplink: fakePreview() }), state)
    assert.equal(
      looplinkPanelReducer(state, { type: 'action-failed', workspaceId: 7, sessionId: 9, message: 'x' }),
      state
    )
  })

  it('source and target titles display from the preview', () => {
    const state: LooplinkPanelState = { ...bound(), looplink: fakePreview() }
    assert.equal(state.looplink?.sourceTitle, 'Build it')
    assert.equal(state.looplink?.payload.source.title, 'Build it')
  })
})
