import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodingMessage, CodingSession } from '../../../../shared/sessions/types'
import {
  initialSessionPanelState,
  sessionPanelReducer,
  type SessionPanelState
} from './session-state'

function makeSession(id: number, workspaceId: number, title: string, updatedAt: number): CodingSession {
  return { id, workspaceId, title, createdAt: 1000, updatedAt }
}

function makeMessage(id: number, sessionId: number, content: string, role: 'user' | 'assistant' = 'user'): CodingMessage {
  return { id, sessionId, role, content, createdAt: 1000 + id }
}

function activeWorkspace(workspaceId: number): SessionPanelState {
  return { ...initialSessionPanelState(), workspaceId }
}

describe('session panel state', () => {
  it('starts with no sessions and no selection', () => {
    const state = activeWorkspace(7)
    assert.deepEqual(state.sessions, [])
    assert.equal(state.selectedSessionId, null)
    assert.deepEqual(state.messages, [])
    assert.equal(state.sending, false)
  })

  it('loads sessions and selects the most recent by default', () => {
    let state = activeWorkspace(7)
    state = sessionPanelReducer(state, { type: 'sessions-loading', workspaceId: 7, requestId: 1 })
    assert.equal(state.loadingSessions, true)
    const sessions = [makeSession(2, 7, 'second', 2000), makeSession(1, 7, 'first', 1000)]
    state = sessionPanelReducer(state, { type: 'sessions-loaded', workspaceId: 7, requestId: 1, sessions })
    assert.equal(state.loadingSessions, false)
    assert.equal(state.selectedSessionId, 2)
  })

  it('keeps the current selection when it still exists', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      sessions: [makeSession(2, 7, 'b', 2000)],
      selectedSessionId: 2,
      messages: [makeMessage(9, 2, 'held')]
    }
    state = sessionPanelReducer(state, {
      type: 'sessions-loaded',
      workspaceId: 7,
      requestId: 1,
      sessions: [makeSession(3, 7, 'c', 3000), makeSession(2, 7, 'b', 2000)]
    })
    assert.equal(state.selectedSessionId, 2)
    assert.equal(state.messages.length, 1)
  })

  it('selecting a session clears the old message view', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      sessions: [makeSession(1, 7, 'a', 1000), makeSession(2, 7, 'b', 2000)],
      selectedSessionId: 1,
      messages: [makeMessage(5, 1, 'old')]
    }
    state = sessionPanelReducer(state, { type: 'session-selected', workspaceId: 7, sessionId: 2 })
    assert.equal(state.selectedSessionId, 2)
    assert.deepEqual(state.messages, [])
    assert.equal(state.hasMore, false)
  })

  it('loads the latest messages replacing the view', () => {
    let state: SessionPanelState = { ...activeWorkspace(7), selectedSessionId: 2 }
    state = sessionPanelReducer(state, { type: 'messages-loading', workspaceId: 7, sessionId: 2, requestId: 1 })
    assert.equal(state.loadingMessages, true)
    const messages = [makeMessage(4, 2, 'four'), makeMessage(5, 2, 'five')]
    state = sessionPanelReducer(state, {
      type: 'messages-loaded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      mode: 'latest',
      messages,
      hasMore: true
    })
    assert.deepEqual(state.messages, messages)
    assert.equal(state.hasMore, true)
  })

  it('prepends older messages and keeps the rest', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      selectedSessionId: 2,
      messages: [makeMessage(4, 2, 'four'), makeMessage(5, 2, 'five')],
      hasMore: true,
      messagesRequestId: 2
    }
    state = sessionPanelReducer(state, {
      type: 'messages-loaded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 2,
      mode: 'older',
      messages: [makeMessage(3, 2, 'three')],
      hasMore: false
    })
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      ['three', 'four', 'five']
    )
    assert.equal(state.hasMore, false)
  })

  it('appends a sent message and clears the send lock', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      sessions: [makeSession(2, 7, 'New session', 1000)],
      selectedSessionId: 2,
      messages: [makeMessage(4, 2, 'before')],
      sending: true
    }
    const session = makeSession(2, 7, 'Derived title', 2000)
    const message = makeMessage(5, 2, 'Hello STARK')
    state = sessionPanelReducer(state, { type: 'send-succeeded', workspaceId: 7, session, message })
    assert.equal(state.sending, false)
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      ['before', 'Hello STARK']
    )
    assert.equal(state.sessions[0]?.title, 'Derived title')
  })

  it('failed sends keep the composer-adjacent state intact', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      selectedSessionId: 2,
      messages: [makeMessage(4, 2, 'before')],
      sending: true
    }
    state = sessionPanelReducer(state, {
      type: 'send-failed',
      workspaceId: 7,
      sessionId: 2,
      message: 'We couldn’t save this message.'
    })
    assert.equal(state.sending, false)
    assert.equal(state.sendError, 'We couldn’t save this message.')
    assert.equal(state.messages.length, 1)
  })

  it('send-started is a single flight: duplicates are ignored', () => {
    const state: SessionPanelState = { ...activeWorkspace(7), selectedSessionId: 2, sending: true }
    const again = sessionPanelReducer(state, { type: 'send-started', workspaceId: 7, sessionId: 2 })
    assert.equal(again.sending, true)
    assert.equal(again, state)
  })

  it('session title updates move the session to the top', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      sessions: [makeSession(3, 7, 'c', 3000), makeSession(2, 7, 'New session', 1000)],
      selectedSessionId: 2,
      messages: []
    }
    state = sessionPanelReducer(state, {
      type: 'send-succeeded',
      workspaceId: 7,
      session: makeSession(2, 7, 'Retitled', 4000),
      message: makeMessage(6, 2, 'hi')
    })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [2, 3]
    )
  })

  it('workspace switch resets everything', () => {
    let state: SessionPanelState = {
      ...activeWorkspace(7),
      sessions: [makeSession(2, 7, 'b', 2000)],
      selectedSessionId: 2,
      messages: [makeMessage(4, 2, 'x')],
      hasMore: true,
      sending: true,
      sessionsRequestId: 3,
      messagesRequestId: 5
    }
    state = sessionPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(state.workspaceId, 8)
    assert.deepEqual(state.sessions, [])
    assert.equal(state.selectedSessionId, null)
    assert.deepEqual(state.messages, [])
    assert.equal(state.hasMore, false)
    assert.equal(state.sending, false)
    assert.equal(state.sessionsRequestId, 0)
    assert.equal(state.messagesRequestId, 0)
  })

  it('ignores stale session responses after switching sessions', () => {
    const state: SessionPanelState = { ...activeWorkspace(7), selectedSessionId: 2, messagesRequestId: 2 }
    const stale = sessionPanelReducer(state, {
      type: 'messages-loaded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      mode: 'latest',
      messages: [makeMessage(1, 2, 'stale')],
      hasMore: false
    })
    assert.equal(stale, state)
  })

  it('ignores stale workspace responses', () => {
    const state: SessionPanelState = { ...activeWorkspace(7), sessionsRequestId: 2 }
    const stale = sessionPanelReducer(state, {
      type: 'sessions-loaded',
      workspaceId: 7,
      requestId: 1,
      sessions: [makeSession(9, 7, 'stale', 1)]
    })
    assert.equal(stale, state)
  })

  it('renders a fixture assistant message without generating one', () => {
    const assistant = makeMessage(6, 2, 'fixture reply', 'assistant')
    let state: SessionPanelState = { ...activeWorkspace(7), selectedSessionId: 2, messagesRequestId: 1 }
    state = sessionPanelReducer(state, {
      type: 'messages-loaded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      mode: 'latest',
      messages: [makeMessage(5, 2, 'q'), assistant],
      hasMore: false
    })
    assert.equal(state.messages[1]?.role, 'assistant')
    // The reducer never fabricates messages: output length equals input.
    assert.equal(state.messages.length, 2)
  })

  it('list ordering follows updatedAt desc from the service payload', () => {
    let state = activeWorkspace(7)
    state = sessionPanelReducer(state, { type: 'sessions-loading', workspaceId: 7, requestId: 1 })
    const sessions = [makeSession(1, 7, 'oldest', 1000), makeSession(2, 7, 'newest', 9000)]
    state = sessionPanelReducer(state, { type: 'sessions-loaded', workspaceId: 7, requestId: 1, sessions })
    assert.deepEqual(
      state.sessions.map((entry) => entry.id),
      [1, 2]
    )
    assert.equal(state.selectedSessionId, 1)
  })
})
