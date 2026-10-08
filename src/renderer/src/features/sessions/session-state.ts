import type { CodingMessage, CodingSession } from '../../../../shared/sessions/types'

/**
 * Pure session-panel state (no React imports) so session listing,
 * selection, paging, send flow, and race safety are unit-testable
 * with the Node runner. Mirrors the search/changes pattern: stale and
 * cross-workspace results are rejected, and switching workspaces
 * clears sessions, selection, messages, composer-adjacent send state,
 * and pagination.
 *
 * Message fetching itself is owned by the component (effects keyed on
 * selection); this reducer only folds explicit, identity-checked
 * outcomes. No timers, no polling, no auto-creation live here.
 */

export interface SessionPanelState {
  readonly workspaceId: number | null
  readonly sessions: readonly CodingSession[]
  readonly selectedSessionId: number | null
  readonly messages: readonly CodingMessage[]
  readonly hasMore: boolean
  readonly loadingSessions: boolean
  readonly sessionsError: string | null
  readonly loadingMessages: boolean
  readonly messagesError: string | null
  readonly sending: boolean
  readonly sendError: string | null
  readonly generating: boolean
  readonly generationError: string | null
  readonly sessionsRequestId: number
  readonly messagesRequestId: number
  readonly generationRequestId: number
}

export function initialSessionPanelState(): SessionPanelState {
  return {
    workspaceId: null,
    sessions: [],
    selectedSessionId: null,
    messages: [],
    hasMore: false,
    loadingSessions: false,
    sessionsError: null,
    loadingMessages: false,
    messagesError: null,
    sending: false,
    sendError: null,
    generating: false,
    generationError: null,
    sessionsRequestId: 0,
    messagesRequestId: 0,
    generationRequestId: 0
  }
}

export type SessionPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'sessions-loading'; readonly workspaceId: number; readonly requestId: number }
  | {
      readonly type: 'sessions-loaded'
      readonly workspaceId: number
      readonly requestId: number
      readonly sessions: readonly CodingSession[]
    }
  | { readonly type: 'sessions-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'session-created'; readonly session: CodingSession }
  | { readonly type: 'session-selected'; readonly workspaceId: number; readonly sessionId: number }
  | {
      readonly type: 'messages-loading'
      readonly workspaceId: number
      readonly sessionId: number
      readonly requestId: number
    }
  | {
      readonly type: 'messages-loaded'
      readonly workspaceId: number
      readonly sessionId: number
      readonly requestId: number
      readonly mode: 'latest' | 'older'
      readonly messages: readonly CodingMessage[]
      readonly hasMore: boolean
    }
  | { readonly type: 'messages-failed'; readonly workspaceId: number; readonly sessionId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'send-started'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'send-succeeded'; readonly workspaceId: number; readonly session: CodingSession; readonly message: CodingMessage }
  | { readonly type: 'send-failed'; readonly workspaceId: number; readonly sessionId: number; readonly message: string }
  | { readonly type: 'send-error-dismissed' }
  | { readonly type: 'work-completed'; readonly workspaceId: number; readonly session: CodingSession; readonly message: CodingMessage }
  | { readonly type: 'generate-started'; readonly workspaceId: number; readonly sessionId: number; readonly requestId: number }
  | {
      readonly type: 'generate-succeeded'
      readonly workspaceId: number
      readonly sessionId: number
      readonly requestId: number
      readonly session: CodingSession
      readonly message: CodingMessage
    }
  | { readonly type: 'generate-failed'; readonly workspaceId: number; readonly sessionId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'generation-error-dismissed' }

function isCurrentSessionsRequest(state: SessionPanelState, workspaceId: number, requestId: number): boolean {
  return state.workspaceId === workspaceId && state.sessionsRequestId === requestId
}

function isCurrentMessagesRequest(
  state: SessionPanelState,
  workspaceId: number,
  sessionId: number,
  requestId: number
): boolean {
  return (
    state.workspaceId === workspaceId &&
    state.selectedSessionId === sessionId &&
    state.messagesRequestId === requestId
  )
}

function upsertSessionTop(sessions: readonly CodingSession[], session: CodingSession): CodingSession[] {
  return [session, ...sessions.filter((entry) => entry.id !== session.id)]
}

export function sessionPanelReducer(state: SessionPanelState, action: SessionPanelAction): SessionPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialSessionPanelState(), workspaceId: action.workspaceId }
    case 'sessions-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loadingSessions: true, sessionsError: null, sessionsRequestId: action.requestId }
    }
    case 'sessions-loaded': {
      if (!isCurrentSessionsRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      // Natural resume: keep the current selection when it still exists,
      // otherwise select the most recently updated session (first row).
      const stillThere =
        state.selectedSessionId !== null && action.sessions.some((entry) => entry.id === state.selectedSessionId)
      const selectedSessionId = stillThere
        ? state.selectedSessionId
        : (action.sessions[0]?.id ?? null)
      const selectionChanged = selectedSessionId !== state.selectedSessionId
      return {
        ...state,
        loadingSessions: false,
        sessions: action.sessions,
        sessionsError: null,
        selectedSessionId,
        // A changed selection invalidates the visible messages; the
        // component effect loads the new session's latest page.
        messages: selectionChanged ? [] : state.messages,
        hasMore: selectionChanged ? false : state.hasMore,
        messagesError: selectionChanged ? null : state.messagesError
      }
    }
    case 'sessions-failed': {
      if (!isCurrentSessionsRequest(state, action.workspaceId, action.requestId)) {
        return state
      }
      return { ...state, loadingSessions: false, sessionsError: action.message }
    }
    case 'session-created': {
      return {
        ...state,
        sessions: upsertSessionTop(state.sessions, action.session),
        selectedSessionId: action.session.id,
        messages: [],
        hasMore: false,
        messagesError: null,
        sendError: null,
        generating: false,
        generationError: null
      }
    }
    case 'session-selected': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      if (state.selectedSessionId === action.sessionId) {
        return state
      }
      return {
        ...state,
        selectedSessionId: action.sessionId,
        messages: [],
        hasMore: false,
        loadingMessages: false,
        messagesError: null,
        sending: false,
        sendError: null,
        generating: false,
        generationError: null
      }
    }
    case 'messages-loading': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.sessionId) {
        return state
      }
      return { ...state, loadingMessages: true, messagesError: null, messagesRequestId: action.requestId }
    }
    case 'messages-loaded': {
      if (!isCurrentMessagesRequest(state, action.workspaceId, action.sessionId, action.requestId)) {
        return state
      }
      return {
        ...state,
        loadingMessages: false,
        messagesError: null,
        messages:
          action.mode === 'latest' ? action.messages : [...action.messages, ...state.messages],
        hasMore: action.hasMore
      }
    }
    case 'messages-failed': {
      if (!isCurrentMessagesRequest(state, action.workspaceId, action.sessionId, action.requestId)) {
        return state
      }
      return { ...state, loadingMessages: false, messagesError: action.message }
    }
    case 'send-started': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.sessionId) {
        return state
      }
      if (state.sending) {
        return state
      }
      return { ...state, sending: true, sendError: null }
    }
    case 'send-succeeded': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.session.id) {
        return state
      }
      return {
        ...state,
        sending: false,
        sendError: null,
        sessions: upsertSessionTop(state.sessions, action.session),
        messages: [...state.messages, action.message]
      }
    }
    case 'send-failed': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.sessionId) {
        return state
      }
      return { ...state, sending: false, sendError: action.message }
    }
    case 'send-error-dismissed':
      return { ...state, sendError: null }
    case 'work-completed': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.session.id) {
        return state
      }
      return {
        ...state,
        sessions: upsertSessionTop(state.sessions, action.session),
        messages: [...state.messages, action.message]
      }
    }
    case 'generate-started': {
      if (state.workspaceId !== action.workspaceId || state.selectedSessionId !== action.sessionId) {
        return state
      }
      if (state.generating) {
        return state
      }
      return { ...state, generating: true, generationError: null, generationRequestId: action.requestId }
    }
    case 'generate-succeeded': {
      if (
        state.workspaceId !== action.workspaceId ||
        state.selectedSessionId !== action.sessionId ||
        state.generationRequestId !== action.requestId
      ) {
        return state
      }
      return {
        ...state,
        generating: false,
        generationError: null,
        sessions: upsertSessionTop(state.sessions, action.session),
        messages: [...state.messages, action.message]
      }
    }
    case 'generate-failed': {
      if (
        state.workspaceId !== action.workspaceId ||
        state.selectedSessionId !== action.sessionId ||
        state.generationRequestId !== action.requestId
      ) {
        return state
      }
      return { ...state, generating: false, generationError: action.message }
    }
    case 'generation-error-dismissed':
      return { ...state, generationError: null }
  }
}
