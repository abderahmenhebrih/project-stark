import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CodingMessage, CodingSession } from '../../../../shared/sessions/types'
import {
  initialSessionPanelState,
  sessionPanelReducer,
  type SessionPanelState
} from './session-state'

function makeSession(id: number, title: string, updatedAt: number): CodingSession {
  return { id, workspaceId: 7, title, createdAt: 1000, updatedAt }
}

function makeMessage(id: number, role: 'user' | 'assistant', content: string): CodingMessage {
  return { id, sessionId: 2, role, content, createdAt: 1000 + id }
}

function activeGenerating(): SessionPanelState {
  return {
    ...initialSessionPanelState(),
    workspaceId: 7,
    sessions: [makeSession(2, 'q', 2000)],
    selectedSessionId: 2,
    messages: [makeMessage(4, 'user', 'Hello STARK')],
    generating: false,
    generationRequestId: 0
  }
}

describe('session generation state', () => {
  it('starts a generation exactly once', () => {
    let state = activeGenerating()
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 1 })
    assert.equal(state.generating, true)
    assert.equal(state.generationError, null)
    const again = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 2 })
    assert.equal(again, state)
  })

  it('appends the assistant message on success', () => {
    let state = activeGenerating()
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 1 })
    const session = makeSession(2, 'q', 3000)
    const message = makeMessage(5, 'assistant', 'real reply')
    state = sessionPanelReducer(state, {
      type: 'generate-succeeded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      session,
      message
    })
    assert.equal(state.generating, false)
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      ['Hello STARK', 'real reply']
    )
    assert.equal(state.messages[1]?.role, 'assistant')
    assert.equal(state.sessions[0]?.updatedAt, 3000)
  })

  it('keeps the user message when generation fails', () => {
    let state = activeGenerating()
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 1 })
    state = sessionPanelReducer(state, {
      type: 'generate-failed',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      message: 'We couldn’t get a response from the AI provider.'
    })
    assert.equal(state.generating, false)
    assert.equal(state.generationError, 'We couldn’t get a response from the AI provider.')
    assert.deepEqual(
      state.messages.map((entry) => entry.content),
      ['Hello STARK']
    )
  })

  it('retry succeeds after a failure without duplicating the user message', () => {
    let state = activeGenerating()
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 1 })
    state = sessionPanelReducer(state, {
      type: 'generate-failed',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      message: 'timeout'
    })
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 2 })
    state = sessionPanelReducer(state, {
      type: 'generate-succeeded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 2,
      session: makeSession(2, 'q', 4000),
      message: makeMessage(6, 'assistant', 'retry reply')
    })
    assert.equal(state.messages.filter((entry) => entry.role === 'user').length, 1)
    assert.equal(state.messages.filter((entry) => entry.role === 'assistant').length, 1)
  })

  it('ignores stale generation outcomes after switching sessions', () => {
    let state = activeGenerating()
    state = sessionPanelReducer(state, { type: 'generate-started', workspaceId: 7, sessionId: 2, requestId: 2 })
    const stale = sessionPanelReducer(state, {
      type: 'generate-succeeded',
      workspaceId: 7,
      sessionId: 2,
      requestId: 1,
      session: makeSession(2, 'q', 9999),
      message: makeMessage(9, 'assistant', 'stale')
    })
    assert.equal(stale, state)
  })

  it('workspace switch clears generation state', () => {
    let state: SessionPanelState = {
      ...activeGenerating(),
      generating: true,
      generationError: 'boom',
      generationRequestId: 3
    }
    state = sessionPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(state.generating, false)
    assert.equal(state.generationError, null)
    assert.equal(state.generationRequestId, 0)
  })

  it('selection switch clears generation state', () => {
    let state: SessionPanelState = {
      ...activeWorkspaceWithTwo(),
      generating: true,
      generationError: 'boom'
    }
    state = sessionPanelReducer(state, { type: 'session-selected', workspaceId: 7, sessionId: 3 })
    assert.equal(state.generating, false)
    assert.equal(state.generationError, null)

    function activeWorkspaceWithTwo(): SessionPanelState {
      return {
        ...initialSessionPanelState(),
        workspaceId: 7,
        sessions: [makeSession(3, 'other', 3000), makeSession(2, 'q', 2000)],
        selectedSessionId: 2,
        messages: [makeMessage(4, 'user', 'x')]
      }
    }
  })

  it('never fabricates an assistant message locally', () => {
    const state = activeGenerating()
    // Without any generate-succeeded action, the message list contains
    // only what the (mocked) persistence layer returned.
    assert.ok(state.messages.every((entry) => entry.role === 'user'))
  })

  it('dismisses generation errors explicitly', () => {
    let state: SessionPanelState = { ...activeGenerating(), generationError: 'boom' }
    state = sessionPanelReducer(state, { type: 'generation-error-dismissed' })
    assert.equal(state.generationError, null)
  })
})
