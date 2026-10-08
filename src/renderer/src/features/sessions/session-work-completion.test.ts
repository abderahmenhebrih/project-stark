import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodingMessage, CodingSession } from '../../../../shared/sessions/types'
import { initialSessionPanelState, sessionPanelReducer, type SessionPanelState } from './session-state'

function makeSession(): CodingSession {
  return { id: 3, workspaceId: 7, title: 't', createdAt: 1000, updatedAt: 2000 }
}

function makeMessage(id: number, role: 'user' | 'assistant', content: string): CodingMessage {
  return { id, sessionId: 3, role, content, createdAt: 1000 + id }
}

describe('session work completion', () => {
  it('appends the brain assistant message and refreshes the session', () => {
    let state: SessionPanelState = {
      ...initialSessionPanelState(),
      workspaceId: 7,
      sessions: [makeSession()],
      selectedSessionId: 3,
      messages: [makeMessage(21, 'user', 'Hi.')]
    }
    state = sessionPanelReducer(state, {
      type: 'work-completed',
      workspaceId: 7,
      session: { ...makeSession(), updatedAt: 3000 },
      message: makeMessage(22, 'assistant', 'FINAL_OK')
    })
    assert.deepEqual(state.messages.map((entry) => entry.content), ['Hi.', 'FINAL_OK'])
    assert.equal(state.messages[1]?.role, 'assistant')
    // No user-message duplication happened.
    assert.equal(state.messages.filter((entry) => entry.role === 'user').length, 1)
  })

  it('ignores cross-session work completions', () => {
    const state = {
      ...initialSessionPanelState(),
      workspaceId: 7,
      sessions: [makeSession()],
      selectedSessionId: 3,
      messages: [makeMessage(21, 'user', 'Hi.')]
    }
    const other = sessionPanelReducer(state, {
      type: 'work-completed',
      workspaceId: 7,
      session: { ...makeSession(), id: 9 },
      message: makeMessage(30, 'assistant', 'stale')
    })
    assert.equal(other, state)
  })
})
