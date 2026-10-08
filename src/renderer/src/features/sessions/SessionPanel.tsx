import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type { CodingMessage } from '../../../../shared/sessions/types'
import type { SessionContextDraft } from '../../../../shared/context/types'
import type { ProviderConnectionStatus } from '../../../../shared/providers/types'
import {
  createCodingSession,
  listCodingSessions,
  listSessionMessages,
  sendSessionUserMessage
} from '../../lib/sessions-api'
import {
  SESSION_LIST_MESSAGE,
  SESSION_MESSAGES_MESSAGE,
  SESSION_SAVE_MESSAGE,
  normalizeSessionError
} from '../../lib/session-error'
import {
  CONTEXT_ITEM_TOO_LARGE_MESSAGE,
  CONTEXT_PREPARE_MESSAGE,
  CONTEXT_RANGE_MESSAGE,
  CONTEXT_TOO_MANY_MESSAGE,
  CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
  CONTEXT_UNAVAILABLE_MESSAGE,
  CONTEXT_UNSUPPORTED_MESSAGE,
  normalizeContextError
} from '../../lib/session-context-error'
import { prepareContextNote } from '../../lib/session-context-api'
import {
  clearProviderCredential,
  generateAssistantResponse,
  getProviderState,
  listProviderModels,
  saveProviderCredential,
  setProviderModel,
  testProviderConnection
} from '../../lib/providers-api'
import {
  PROVIDER_GENERIC_MESSAGE,
  normalizeProviderError
} from '../../lib/provider-error'
import { isComposerEmpty, shouldSubmitComposerKey } from './composer-keys'
import { ContextCard } from './ContextCard'
import { initialProviderPanelState, providerPanelReducer } from './provider-state'
import { initialSessionPanelState, sessionPanelReducer } from './session-state'
import type { SessionContextDraftAction } from './session-context-state'
import './session.css'

interface SessionPanelProps {
  readonly workspaceId: number
  readonly onCollapse: () => void
  readonly contextDrafts: readonly SessionContextDraft[]
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  readonly contextDraftError: string | null
}

const OPENAI_PROVIDER_ID = 'openai' as const

/** Renderer-side composer byte cap (main enforces authoritatively). */
const COMPOSER_MAX_BYTES = 64 * 1024

function composerByteLength(content: string): number {
  return new TextEncoder().encode(content).length
}

function toErrorMessage(error: unknown, fallback: string): string {
  return normalizeSessionError(error, fallback).message
}

function toProviderErrorMessage(error: unknown, fallback: string): string {
  return normalizeProviderError(error, fallback).message
}

function toSendErrorMessage(error: unknown): string {
  // Context attachment failures carry their own safe copy; anything
  // else falls back to the session send boundary.
  if (error instanceof Error && error.message !== '') {
    const known = [
      CONTEXT_ITEM_TOO_LARGE_MESSAGE,
      CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
      CONTEXT_TOO_MANY_MESSAGE,
      CONTEXT_UNSUPPORTED_MESSAGE,
      CONTEXT_UNAVAILABLE_MESSAGE,
      CONTEXT_RANGE_MESSAGE,
      CONTEXT_PREPARE_MESSAGE
    ]
    if (known.some((message) => error.message.includes(message))) {
      return normalizeContextError(error, SESSION_SAVE_MESSAGE).message
    }
  }
  return toErrorMessage(error, SESSION_SAVE_MESSAGE)
}

function roleLabel(role: CodingMessage['role']): string {
  return role === 'assistant' ? 'STARK' : 'YOU'
}

function formatTime(createdAt: number): string {
  try {
    return new Date(createdAt).toLocaleString()
  } catch {
    return ''
  }
}

function connectionStatusLabel(status: ProviderConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected.'
    case 'invalid-credential':
      return 'The saved API key was rejected. Check the key and try again.'
    case 'rate-limited':
      return 'The AI provider is rate-limiting requests. Try again shortly.'
    case 'network-error':
      return 'The AI provider could not be reached. Check your connection.'
    case 'timeout':
      return 'The AI provider request timed out. Try again.'
  }
}

/**
 * Persistent STARK Session panel (Stage 14: local sessions + real AI).
 *
 * Explicit session lifecycle — never auto-creates: empty workspaces
 * show New session, otherwise the most recently updated session
 * resumes with its latest 100 messages. The composer stores one user
 * message per send; when a provider and model are configured, the
 * send is followed by exactly one bounded, non-streaming generation
 * whose real assistant text appends to the same conversation. Failures
 * keep the user message and offer an explicit Retry response — never
 * automatic retries, never fabricated replies. Stale loads from
 * previous sessions/workspaces are ignored via request identity; the
 * component remounts per workspace (`key={workspaceId}`) so switches
 * clear sessions, selection, messages, composer, pagination, provider
 * view state, and generation state. No polling, no timers.
 */
export function SessionPanel({
  workspaceId,
  onCollapse,
  contextDrafts,
  contextDraftsDispatch,
  contextDraftError
}: SessionPanelProps): ReactElement {
  const [state, dispatch] = useReducer(sessionPanelReducer, workspaceId, (id) => ({
    ...initialSessionPanelState(),
    workspaceId: id
  }))
  const [provider, providerDispatch] = useReducer(providerPanelReducer, workspaceId, (id) => ({
    ...initialProviderPanelState(),
    workspaceId: id
  }))
  const [composer, setComposer] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [revealKey, setRevealKey] = useState(false)
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const sessionsRequestRef = useRef(0)
  const messagesRequestRef = useRef(0)
  const generationRequestRef = useRef(0)
  const providerStateRequestRef = useRef(0)
  const providerModelsRequestRef = useRef(0)
  const providerConnectionRequestRef = useRef(0)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const aiReady = provider.configured && provider.selectedModel !== null

  function scrollToBottom(): void {
    const element = messagesScrollRef.current
    if (element !== null) {
      element.scrollTop = element.scrollHeight
    }
  }

  useEffect(() => {
    if (stickToBottomRef.current) {
      stickToBottomRef.current = false
      scrollToBottom()
    }
  }, [state.messages])

  function refreshProviderState(): void {
    const requestId = providerStateRequestRef.current + 1
    providerStateRequestRef.current = requestId
    providerDispatch({ type: 'state-loading', workspaceId, requestId })
    getProviderState(OPENAI_PROVIDER_ID).then(
      (providerState) => {
        if (providerStateRequestRef.current !== requestId) {
          return
        }
        providerDispatch({ type: 'state-loaded', workspaceId, requestId, state: providerState })
      },
      (error: unknown) => {
        if (providerStateRequestRef.current !== requestId) {
          return
        }
        providerDispatch({
          type: 'state-failed',
          workspaceId,
          requestId,
          message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
        })
      }
    )
  }

  // Workspace activation: reset identity, load recent sessions and the
  // provider state once. (Composer, key input, and drafts start empty
  // because the panel remounts per workspace.)
  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    providerDispatch({ type: 'workspace-changed', workspaceId })
    sessionsRequestRef.current = 0
    messagesRequestRef.current = 0
    generationRequestRef.current = 0
    providerStateRequestRef.current = 0
    providerModelsRequestRef.current = 0
    providerConnectionRequestRef.current = 0
    const requestId = sessionsRequestRef.current + 1
    sessionsRequestRef.current = requestId
    dispatch({ type: 'sessions-loading', workspaceId, requestId })
    listCodingSessions(workspaceId).then(
      (sessions) => {
        if (sessionsRequestRef.current !== requestId) {
          return
        }
        dispatch({ type: 'sessions-loaded', workspaceId, requestId, sessions })
      },
      (error: unknown) => {
        if (sessionsRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'sessions-failed',
          workspaceId,
          requestId,
          message: toErrorMessage(error, SESSION_LIST_MESSAGE)
        })
      }
    )
    refreshProviderState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Selection (including the reducer's default to the most recent
  // session): load that session's latest page, exactly once per
  // selection identity.
  const selectedSessionId = state.selectedSessionId
  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }
    const sessionId = selectedSessionId
    const requestId = messagesRequestRef.current + 1
    messagesRequestRef.current = requestId
    dispatch({ type: 'messages-loading', workspaceId, sessionId, requestId })
    listSessionMessages({ workspaceId, sessionId }).then(
      (page) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        stickToBottomRef.current = true
        dispatch({
          type: 'messages-loaded',
          workspaceId,
          sessionId,
          requestId,
          mode: 'latest',
          messages: page.messages,
          hasMore: page.hasMore
        })
      },
      (error: unknown) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-failed',
          workspaceId,
          sessionId,
          requestId,
          message: toErrorMessage(error, SESSION_MESSAGES_MESSAGE)
        })
      }
    )
  }, [workspaceId, selectedSessionId])

  async function runGeneration(sessionId: number): Promise<void> {
    if (state.generating) {
      return
    }
    const requestId = generationRequestRef.current + 1
    generationRequestRef.current = requestId
    dispatch({ type: 'generate-started', workspaceId, sessionId, requestId })
    try {
      const result = await generateAssistantResponse({ workspaceId, sessionId })
      if (generationRequestRef.current !== requestId) {
        return
      }
      stickToBottomRef.current = true
      dispatch({
        type: 'generate-succeeded',
        workspaceId,
        sessionId,
        requestId,
        session: result.session,
        message: result.message
      })
    } catch (error: unknown) {
      if (generationRequestRef.current !== requestId) {
        return
      }
      dispatch({
        type: 'generate-failed',
        workspaceId,
        sessionId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleNew(): Promise<void> {
    if (state.loadingSessions) {
      return
    }
    try {
      const session = await createCodingSession(workspaceId)
      dispatch({ type: 'session-created', session })
      setComposer('')
      composerRef.current?.focus()
    } catch (error: unknown) {
      dispatch({
        type: 'sessions-failed',
        workspaceId,
        requestId: state.sessionsRequestId,
        message: toErrorMessage(error, SESSION_LIST_MESSAGE)
      })
    }
  }

  function handleSelect(sessionId: number): void {
    if (sessionId === state.selectedSessionId) {
      return
    }
    dispatch({ type: 'session-selected', workspaceId, sessionId })
  }

  function handleLoadOlder(): void {
    const oldest = state.messages[0]
    if (state.selectedSessionId === null || oldest === undefined || state.loadingMessages) {
      return
    }
    const sessionId = state.selectedSessionId
    const requestId = messagesRequestRef.current + 1
    messagesRequestRef.current = requestId
    dispatch({ type: 'messages-loading', workspaceId, sessionId, requestId })
    listSessionMessages({ workspaceId, sessionId, beforeMessageId: oldest.id }).then(
      (page) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-loaded',
          workspaceId,
          sessionId,
          requestId,
          mode: 'older',
          messages: page.messages,
          hasMore: page.hasMore
        })
      },
      (error: unknown) => {
        if (messagesRequestRef.current !== requestId) {
          return
        }
        dispatch({
          type: 'messages-failed',
          workspaceId,
          sessionId,
          requestId,
          message: toErrorMessage(error, SESSION_MESSAGES_MESSAGE)
        })
      }
    )
  }

  async function handleSend(): Promise<void> {
    if (state.selectedSessionId === null || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    const content = composer
    if (isComposerEmpty(content) || composerByteLength(content) > COMPOSER_MAX_BYTES) {
      return
    }
    const generateAfterSend = aiReady
    const attached = [...contextDrafts]
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(
        attached.length === 0
          ? { workspaceId, sessionId, content }
          : { workspaceId, sessionId, content, context: attached }
      )
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      // Clear only the sent text: keystrokes typed during the send are
      // newer composer state and must be preserved. The reducer drops
      // the result entirely if the selection moved on meanwhile.
      setComposer((current) => (current === content ? '' : current))
      // Drafts are renderer-local: sending consumes exactly the
      // attached snapshot, so they clear on success only.
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
      if (generateAfterSend) {
        await runGeneration(sessionId)
      }
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
    }
  }

  function handleRemoveDraft(draftId: string): void {
    contextDraftsDispatch({ type: 'draft-removed', workspaceId, draftId })
  }

  async function handleAddNote(): Promise<void> {
    if (isComposerEmpty(noteText)) {
      return
    }
    const content = noteText
    try {
      const draft = await prepareContextNote({ workspaceId, content })
      contextDraftsDispatch({ type: 'draft-added', workspaceId, draft })
      setNoteText('')
      setNoteOpen(false)
    } catch (error: unknown) {
      contextDraftsDispatch({
        type: 'draft-failed',
        workspaceId,
        message: normalizeContextError(error).message
      })
    }
  }

  function handleRetry(): void {
    if (state.selectedSessionId === null || state.generating) {
      return
    }
    void runGeneration(state.selectedSessionId)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const overLimit = composerByteLength(composer) > COMPOSER_MAX_BYTES
    if (
      shouldSubmitComposerKey(
        { key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing },
        {
          hasSession: state.selectedSessionId !== null,
          isEmpty: isComposerEmpty(composer),
          sending: state.sending,
          overLimit
        }
      )
    ) {
      event.preventDefault()
      void handleSend()
    }
  }

  async function handleSaveKey(): Promise<void> {
    if (apiKeyInput.trim() === '') {
      return
    }
    try {
      const providerState = await saveProviderCredential({ providerId: OPENAI_PROVIDER_ID, apiKey: apiKeyInput })
      providerDispatch({
        type: 'state-loaded',
        workspaceId,
        requestId: provider.requestId,
        state: providerState
      })
      // The input is write-only: cleared immediately, never repopulated
      // from storage. There is no "show saved key" path.
      setApiKeyInput('')
      setRevealKey(false)
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleRemoveKey(): Promise<void> {
    try {
      const providerState = await clearProviderCredential(OPENAI_PROVIDER_ID)
      providerDispatch({ type: 'state-loaded', workspaceId, requestId: provider.requestId, state: providerState })
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleTestConnection(): Promise<void> {
    if (!provider.configured) {
      return
    }
    const requestId = providerConnectionRequestRef.current + 1
    providerConnectionRequestRef.current = requestId
    providerDispatch({ type: 'connection-started', workspaceId, requestId })
    try {
      const result = await testProviderConnection(OPENAI_PROVIDER_ID)
      if (providerConnectionRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'connection-finished',
        workspaceId,
        requestId,
        status: result.status,
        models: result.models
      })
    } catch (error: unknown) {
      if (providerConnectionRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'connection-failed',
        workspaceId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleRefreshModels(): Promise<void> {
    if (!provider.configured || provider.loadingModels) {
      return
    }
    const requestId = providerModelsRequestRef.current + 1
    providerModelsRequestRef.current = requestId
    providerDispatch({ type: 'models-loading', workspaceId, requestId })
    try {
      const models = await listProviderModels(OPENAI_PROVIDER_ID)
      if (providerModelsRequestRef.current !== requestId) {
        return
      }
      providerDispatch({ type: 'models-loaded', workspaceId, requestId, models })
    } catch (error: unknown) {
      if (providerModelsRequestRef.current !== requestId) {
        return
      }
      providerDispatch({
        type: 'models-failed',
        workspaceId,
        requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  async function handleUseModel(): Promise<void> {
    if (modelDraft === null || modelDraft === provider.selectedModel) {
      return
    }
    try {
      const providerState = await setProviderModel({ providerId: OPENAI_PROVIDER_ID, model: modelDraft })
      providerDispatch({ type: 'state-loaded', workspaceId, requestId: provider.requestId, state: providerState })
      setModelDraft(null)
    } catch (error: unknown) {
      providerDispatch({
        type: 'state-failed',
        workspaceId,
        requestId: provider.requestId,
        message: toProviderErrorMessage(error, PROVIDER_GENERIC_MESSAGE)
      })
    }
  }

  const selectedSession = state.sessions.find((entry) => entry.id === state.selectedSessionId) ?? null
  const empty = isComposerEmpty(composer)
  const overLimit = composerByteLength(composer) > COMPOSER_MAX_BYTES
  // loadingMessages gates sending: a latest page in flight must settle
  // first, otherwise its replace-on-arrive could drop a just-appended
  // message. Older-page loads only prepend, so they never clobber.
  const sendDisabled =
    state.selectedSessionId === null || empty || state.sending || overLimit || state.loadingMessages
  const latestMessage = state.messages[state.messages.length - 1] ?? null
  const showRetry =
    latestMessage !== null &&
    latestMessage.role === 'user' &&
    aiReady &&
    !state.generating &&
    !state.loadingMessages
  const modelValue = modelDraft ?? provider.selectedModel ?? ''
  const selectedModel = provider.selectedModel
  const selectedModelMissing =
    selectedModel !== null && !provider.models.some((entry) => entry.id === selectedModel)

  return (
    <section className="session" aria-label="STARK Session">
      <div className="session__header">
        <p className="session__eyebrow">Session</p>
        <p className="session__title">{selectedSession?.title ?? 'No session'}</p>
        <button className="explorer__secondary" type="button" onClick={() => void handleNew()} disabled={state.loadingSessions}>
          New
        </button>
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label="Toggle AI settings"
        >
          AI Settings
        </button>
        <button className="explorer__secondary" type="button" onClick={onCollapse} aria-label="Hide session panel">
          Hide
        </button>
      </div>
      <p className="session__notice" role="status">
        {aiReady ? `OpenAI · ${provider.selectedModel ?? ''}` : 'Local session — AI provider not connected yet.'}
      </p>
      {settingsOpen && (
        <div className="session__settings" aria-label="AI settings">
          <div className="session__settings-row">
            <span className="session__eyebrow">Provider</span>
            <span className="session__provider-name">{provider.displayName}</span>
          </div>
          {!provider.secureStorageAvailable && (
            <p className="session__error" role="alert">
              Secure credential storage is not available on this system.
            </p>
          )}
          <label className="session__eyebrow" htmlFor="session-api-key">
            API key
          </label>
          <div className="session__settings-row">
            <input
              id="session-api-key"
              className="session__field"
              type={revealKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder="Paste OpenAI API key…"
              autoComplete="off"
              spellCheck={false}
              aria-label="OpenAI API key"
            />
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => setRevealKey((reveal) => !reveal)}
              aria-label={revealKey ? 'Hide typed key' : 'Reveal typed key'}
            >
              {revealKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveKey()}
              disabled={apiKeyInput.trim() === '' || !provider.secureStorageAvailable}
            >
              Save key
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleRemoveKey()}
              disabled={!provider.configured}
            >
              Remove key
            </button>
            <span className="session__hint">{provider.configured ? 'Configured' : 'Not configured'}</span>
          </div>
          {provider.error !== null && (
            <p className="session__error" role="alert">
              {provider.error}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={!provider.configured || provider.connectionPhase === 'testing'}
            >
              {provider.connectionPhase === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleRefreshModels()}
              disabled={!provider.configured || provider.loadingModels}
            >
              {provider.loadingModels ? 'Loading…' : 'Refresh models'}
            </button>
          </div>
          {provider.connectionPhase === 'done' && provider.connectionStatus !== null && (
            <p className="session__status" role="status">
              Connection: {connectionStatusLabel(provider.connectionStatus)}
            </p>
          )}
          {provider.connectionPhase === 'error' && provider.connectionError !== null && (
            <p className="session__error" role="alert">
              {provider.connectionError}
            </p>
          )}
          <label className="session__eyebrow" htmlFor="session-model-select">
            Model
          </label>
          <div className="session__settings-row">
            <select
              id="session-model-select"
              className="session__select"
              value={modelValue}
              onChange={(event) => setModelDraft(event.target.value)}
              disabled={!provider.configured || (provider.models.length === 0 && provider.selectedModel === null)}
              aria-label="Available models"
            >
              {modelValue === '' && <option value="">Select a model…</option>}
              {selectedModelMissing && selectedModel !== null ? (
                <option key={selectedModel} value={selectedModel}>
                  {selectedModel}
                </option>
              ) : null}
              {provider.models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleUseModel()}
              disabled={modelDraft === null || modelDraft === provider.selectedModel}
            >
              Use model
            </button>
          </div>
          {provider.modelsError !== null && (
            <p className="session__error" role="alert">
              {provider.modelsError}
            </p>
          )}
        </div>
      )}
      {state.loadingSessions && state.sessions.length === 0 ? (
        <div className="session__empty">
          <p className="session__status" role="status">
            Loading sessions…
          </p>
        </div>
      ) : state.sessions.length === 0 ? (
        <div className="session__empty">
          <p className="session__empty-text">No coding sessions yet.</p>
          <button className="explorer__primary" type="button" onClick={() => void handleNew()}>
            New session
          </button>
          {state.sessionsError !== null && (
            <p className="session__error" role="alert">
              {state.sessionsError}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="session__history">
            <label className="session__eyebrow" htmlFor="session-history-select">
              History
            </label>
            <select
              id="session-history-select"
              className="session__select"
              value={state.selectedSessionId ?? ''}
              onChange={(event) => handleSelect(Number(event.target.value))}
              aria-label="Recent sessions"
            >
              {state.sessions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </div>
          {state.sessionsError !== null && (
            <p className="session__error" role="alert">
              {state.sessionsError}
            </p>
          )}
          <div className="session__messages" ref={messagesScrollRef} aria-label="Messages" aria-live="off">
            {state.hasMore && (
              <button
                className="explorer__secondary"
                type="button"
                onClick={handleLoadOlder}
                disabled={state.loadingMessages}
              >
                {state.loadingMessages ? 'Loading…' : 'Load older messages'}
              </button>
            )}
            {state.loadingMessages && state.messages.length === 0 ? (
              <p className="session__status" role="status">
                Loading messages…
              </p>
            ) : state.messagesError !== null ? (
              <p className="session__error" role="alert">
                {state.messagesError}
              </p>
            ) : (
              <ul className="session__list" aria-label="Message list">
                {state.messages.map((message) => (
                  <li
                    key={message.id}
                    className={
                      message.role === 'assistant' ? 'session__message session__message--assistant' : 'session__message'
                    }
                  >
                    <span className="session__role">{roleLabel(message.role)}</span>
                    <p className="session__content">{message.content}</p>
                    {(message.context ?? []).length > 0 && (
                      <div className="session__sent-context" aria-label={`Context sent with message ${message.id}`}>
                        {(message.context ?? []).map((item) => (
                          <ContextCard
                            key={item.id}
                            label={item.label}
                            detail={item.kind}
                            content={item.content}
                            removable={false}
                          />
                        ))}
                      </div>
                    )}
                    <span className="session__time">{formatTime(message.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {state.generating && (
              <p className="session__status" role="status">
                STARK is thinking…
              </p>
            )}
            {state.generationError !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{state.generationError}</p>
                {showRetry && (
                  <button className="explorer__secondary" type="button" onClick={handleRetry}>
                    Retry response
                  </button>
                )}
              </div>
            )}
            {showRetry && state.generationError === null && (
              <button className="explorer__secondary" type="button" onClick={handleRetry}>
                Retry response
              </button>
            )}
          </div>
          <div className="session__context" aria-label="Attached context">
            <div className="session__context-header">
              <p className="session__eyebrow">Attached context</p>
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => setNoteOpen((open) => !open)}
                aria-expanded={noteOpen}
              >
                Add note
              </button>
            </div>
            {contextDraftError !== null && (
              <p className="session__error" role="alert">
                {contextDraftError}
              </p>
            )}
            {contextDrafts.length === 0 ? (
              <p className="session__empty-text">No context attached. Only what you attach here is sent to the AI.</p>
            ) : (
              <ul className="session__context-list">
                {contextDrafts.map((draft) => (
                  <li key={draft.draftId}>
                    <ContextCard
                      label={draft.label}
                      detail={draft.kind}
                      content={draft.content}
                      removable
                      onRemove={() => handleRemoveDraft(draft.draftId)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {noteOpen && (
              <div className="session__note-form">
                <label className="session__eyebrow" htmlFor="session-note-input">
                  Manual note
                </label>
                <textarea
                  id="session-note-input"
                  className="session__input"
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder="Type a short note or snippet…"
                  aria-label="Manual context note"
                  rows={3}
                />
                <div className="session__composer-row">
                  <button
                    className="explorer__primary"
                    type="button"
                    onClick={() => void handleAddNote()}
                    disabled={isComposerEmpty(noteText)}
                  >
                    Attach note
                  </button>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => {
                      setNoteOpen(false)
                      setNoteText('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="session__composer">
            {state.sendError !== null && (
              <p className="session__error" role="alert">
                {state.sendError}
              </p>
            )}
            {overLimit && (
              <p className="session__error" role="alert">
                This message is too large.
              </p>
            )}
            <textarea
              ref={composerRef}
              className="session__input"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Message STARK… (Enter to send, Shift+Enter for a new line)"
              aria-label="Message composer"
              rows={3}
              disabled={state.sending}
            />
            <div className="session__composer-row">
              <p className="session__hint">
                {aiReady ? 'Stored locally. STARK will reply.' : 'Stored locally. No AI reply yet.'}
              </p>
              <button
                className="explorer__primary"
                type="button"
                onClick={() => void handleSend()}
                disabled={sendDisabled}
              >
                {state.sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
