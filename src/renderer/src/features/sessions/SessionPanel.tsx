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
  CONTEXT_STALE_MESSAGE,
  CONTEXT_TOO_MANY_MESSAGE,
  CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
  CONTEXT_UNAVAILABLE_MESSAGE,
  CONTEXT_UNSUPPORTED_MESSAGE,
  normalizeContextError
} from '../../lib/session-context-error'
import { prepareContextNote } from '../../lib/session-context-api'
import {
  clearProviderCredential,
  generateAssistantResponseRaw,
  getProviderState,
  listProviderModels,
  proposeAiChangeSet,
  proposeAiFileChange,
  runBrainWorkRaw,
  saveProviderCredential,
  setProviderModel,
  testProviderConnection
} from '../../lib/providers-api'
import { listRecentOrchestrationRuns } from '../../lib/orchestration-api'
import {
  PROVIDER_GENERIC_MESSAGE,
  normalizeProviderError
} from '../../lib/provider-error'
import { isComposerEmpty, shouldSubmitComposerKey } from './composer-keys'
import { ContextCard } from './ContextCard'
import { initialProviderPanelState, providerPanelReducer } from './provider-state'
import { initialSessionPanelState, sessionPanelReducer } from './session-state'
import type { SessionContextDraftAction } from './session-context-state'
import {
  initialProposalState,
  proposalEligibility,
  proposalReducer,
  type ProposalMode
} from './proposal-state'
import { initialWorkPanelState, workPanelReducer } from './work-state'
import {
  BRAIN_GENERIC_MESSAGE,
  normalizeBrainError
} from '../../lib/brain-error'
import { getHeartConfig, saveHeartConfig } from '../../lib/heart-api'
import { initialHeartPanelState, heartPanelReducer } from './heart-state'
import { dismissRecovery, getRecoveryConfig, getRecoveryForTarget, saveRecoveryConfig } from '../../lib/recovery-api'
import { initialRecoveryPanelState, recoveryPanelReducer, recoverySourceCopy, recoveryTargetCopy } from './recovery-state'
import {
  approveWorkerApproval,
  denyWorkerApproval,
  getPendingWorkerApproval
} from '../../lib/worker-tools-api'
import type { WorkerToolApproval } from '../../../../shared/worker-tools/types'
import { getWorkspaceCapabilityConfig, saveWorkspaceCapabilityConfig } from '../../lib/capabilities-api'
import {
  CAPABILITY_ORDER,
  capabilityLabel,
  initialCapabilityPanelState,
  capabilityPanelReducer,
  legalModesFor
} from './capabilities-state'
import { createSessionContinuation, dismissSessionLooplink, getSessionLooplink } from '../../lib/looplink-api'
import { initialLooplinkPanelState, looplinkPanelReducer } from './looplink-state'
import {
  PROPOSAL_GENERIC_MESSAGE,
  normalizeProposalError
} from '../../lib/proposal-error'
import { normalizeChangeSetProposalError } from '../../lib/change-set-error'
import './session.css'

interface SessionPanelProps {
  readonly workspaceId: number
  readonly onCollapse: () => void
  readonly contextDrafts: readonly SessionContextDraft[]
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  readonly contextDraftError: string | null
  readonly onReviewTransaction: (transactionId: number) => void
  readonly onReviewChangeSet: (changeSetId: number) => void
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
  // else falls back to the session send boundary. Stale-context keeps
  // its explicit reattach copy so the composer and chips are retained
  // and the user can remove/reattach — never auto-refreshed.
  if (error instanceof Error && error.message !== '') {
    const known = [
      CONTEXT_ITEM_TOO_LARGE_MESSAGE,
      CONTEXT_TOTAL_TOO_LARGE_MESSAGE,
      CONTEXT_TOO_MANY_MESSAGE,
      CONTEXT_UNSUPPORTED_MESSAGE,
      CONTEXT_UNAVAILABLE_MESSAGE,
      CONTEXT_RANGE_MESSAGE,
      CONTEXT_STALE_MESSAGE,
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
  contextDraftError,
  onReviewTransaction,
  onReviewChangeSet
}: SessionPanelProps): ReactElement {
  const [state, dispatch] = useReducer(sessionPanelReducer, workspaceId, (id) => ({
    ...initialSessionPanelState(),
    workspaceId: id
  }))
  const [provider, providerDispatch] = useReducer(providerPanelReducer, workspaceId, (id) => ({
    ...initialProviderPanelState(),
    workspaceId: id
  }))
  const [proposal, proposalDispatch] = useReducer(proposalReducer, workspaceId, (id) => ({
    ...initialProposalState(),
    workspaceId: id
  }))
  const [work, workDispatch] = useReducer(workPanelReducer, workspaceId, (id) => ({
    ...initialWorkPanelState(),
    workspaceId: id
  }))
  const [heart, heartDispatch] = useReducer(heartPanelReducer, workspaceId, (id) => ({
    ...initialHeartPanelState(),
    workspaceId: id
  }))
  const [looplink, looplinkDispatch] = useReducer(looplinkPanelReducer, workspaceId, (id) => ({
    ...initialLooplinkPanelState(),
    workspaceId: id
  }))
  const [recovery, recoveryDispatch] = useReducer(recoveryPanelReducer, workspaceId, (id) => ({
    ...initialRecoveryPanelState(),
    workspaceId: id
  }))
  const [capabilities, capabilitiesDispatch] = useReducer(capabilityPanelReducer, workspaceId, (id) => ({
    ...initialCapabilityPanelState(),
    workspaceId: id
  }))
  const [pendingApproval, setPendingApproval] = useState<WorkerToolApproval | null>(null)
  const [approvalActing, setApprovalActing] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
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

  async function refreshHeartConfig(targetWorkspaceId: number): Promise<void> {
    heartDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getHeartConfig()
      heartDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      heartDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the Heart configuration.'
      })
    }
  }

  async function handleSaveHeart(): Promise<void> {
    if (heart.saving) {
      return
    }
    const draft = heart.draft
    heartDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveHeartConfig({
        workerMode: draft.workerMode,
        brain: { ...draft.brain },
        workerFixed: draft.workerMode === 'fixed' || draft.workerFixed.model !== '' ? { ...draft.workerFixed } : null,
        workerDefault: draft.workerMode === 'auto_swap' || draft.workerDefault.model !== '' ? { ...draft.workerDefault } : null,
        workerRoutes: {
          general: draft.workerRoutes.general.model !== '' ? { ...draft.workerRoutes.general } : null,
          coding: draft.workerRoutes.coding.model !== '' ? { ...draft.workerRoutes.coding } : null,
          reasoning: draft.workerRoutes.reasoning.model !== '' ? { ...draft.workerRoutes.reasoning } : null,
          fast: draft.workerRoutes.fast.model !== '' ? { ...draft.workerRoutes.fast } : null
        }
      })
      heartDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      heartDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the Heart configuration.'
      })
    }
  }
  async function refreshRecoveryConfig(targetWorkspaceId: number): Promise<void> {
    recoveryDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getRecoveryConfig()
      recoveryDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the recovery configuration.'
      })
    }
  }

  async function handleSaveRecovery(): Promise<void> {
    if (recovery.saving) {
      return
    }
    const draft = recovery.draft
    recoveryDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveRecoveryConfig({
        mode: draft.mode,
        ask: draft.ask.model !== '' ? { ...draft.ask } : null,
        brain: draft.brain.model !== '' ? { ...draft.brain } : null,
        worker: draft.worker.model !== '' ? { ...draft.worker } : null
      })
      recoveryDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the recovery configuration.'
      })
    }
  }
  async function refreshCapabilityConfig(targetWorkspaceId: number): Promise<void> {
    capabilitiesDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getWorkspaceCapabilityConfig({ workspaceId: targetWorkspaceId })
      capabilitiesDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      capabilitiesDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the workspace permissions.'
      })
    }
  }

  async function handleSaveCapabilities(): Promise<void> {
    if (capabilities.saving) {
      return
    }
    capabilitiesDispatch({ type: 'save-started', workspaceId })
    try {
      const config = await saveWorkspaceCapabilityConfig({
        workspaceId,
        enabled: capabilities.draft.enabled,
        policies: CAPABILITY_ORDER.map((capability) => ({ capability, mode: capabilities.draft.modes[capability] }))
      })
      capabilitiesDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      capabilitiesDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the workspace permissions.'
      })
    }
  }
  // Workspace activation: reset identity, load recent sessions and the
  // provider state once. (Composer, key input, and drafts start empty
  // because the panel remounts per workspace.)
  useEffect(() => {
    dispatch({ type: 'workspace-changed', workspaceId })
    providerDispatch({ type: 'workspace-changed', workspaceId })
    proposalDispatch({ type: 'workspace-changed', workspaceId })
    workDispatch({ type: 'workspace-changed', workspaceId })
    looplinkDispatch({ type: 'workspace-changed', workspaceId })
    heartDispatch({ type: 'workspace-changed', workspaceId })
    recoveryDispatch({ type: 'workspace-changed', workspaceId })
    capabilitiesDispatch({ type: 'workspace-changed', workspaceId })
    void refreshHeartConfig(workspaceId)
    void refreshRecoveryConfig(workspaceId)
    void refreshCapabilityConfig(workspaceId)
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

  // Keep the transient proposal result bound to the selected session.
  // Switching sessions clears it; the panel remount covers workspaces.
  useEffect(() => {
    if (selectedSessionId === null) {
      return
    }
    proposalDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    workDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    looplinkDispatch({ type: 'session-changed', workspaceId, sessionId: selectedSessionId })
    void loadSessionLooplink(selectedSessionId)
    void loadRecoveryForSelected(selectedSessionId)
    void loadPendingApproval(selectedSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, selectedSessionId])

  async function runGeneration(sessionId: number): Promise<void> {
    if (state.generating) {
      return
    }
    const requestId = generationRequestRef.current + 1
    generationRequestRef.current = requestId
    dispatch({ type: 'generate-started', workspaceId, sessionId, requestId })
    try {
      const outcome = await generateAssistantResponseRaw({ workspaceId, sessionId })
      if (generationRequestRef.current !== requestId) {
        return
      }
      // Legacy shape (older main without recovery) — treat as completed.
      if (!('kind' in outcome)) {
        const legacy = outcome as { session: never; message: never }
        stickToBottomRef.current = true
        dispatch({
          type: 'generate-succeeded',
          workspaceId,
          sessionId,
          requestId,
          session: legacy.session as never,
          message: legacy.message as never
        })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        dispatch({
          type: 'generate-succeeded',
          workspaceId,
          sessionId,
          requestId,
          session: outcome.result.session,
          message: outcome.result.message
        })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        return
      }
      // Single-hop recovery: the source keeps its user message with a
      // safe recovery notice; the target holds the continued work.
      dispatch({ type: 'session-created', session: outcome.targetSession })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
      if (outcome.kind === 'recovery_handoff') {
        dispatch({
          type: 'generate-failed',
          workspaceId,
          sessionId,
          requestId,
          message: outcome.recoveryEvent.status === 'failed'
            ? 'Recovery attempt failed. No further automatic attempts will be made.'
            : 'STARK created a recovery session.'
        })
      } else {
        dispatch({
          type: 'generate-failed',
          workspaceId,
          sessionId,
          requestId,
          message: 'STARK continued this request in a recovery session.'
        })
      }
      // Offer the target for manual continuation.
      dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
      void loadSessionLooplink(outcome.targetSession.id)
      void loadRecoveryForSelected(outcome.targetSession.id)
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
    if (proposal.mode === 'propose') {
      await handleProposeSend(sessionId, content)
      return
    }
    if (proposal.mode === 'work') {
      await handleWorkSend(sessionId, content)
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

  /**
   * Propose-mode send: persists the user message + reviewed context
   * through the normal Stage 15 path, then runs exactly one bounded
   * structured proposal for the persisted trailing message — the
   * single-file Stage 16 path for one whole file, the Stage 17 Change
   * Set path for two to five. The user message stays on proposal
   * failure; nothing retries automatically.
   */
  async function handleProposeSend(sessionId: number, content: string): Promise<void> {
    if (proposal.preparing) {
      return
    }
    const eligibility = proposalEligibility(contextDrafts)
    if (!eligibility.eligible || eligibility.kind === 'none') {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: eligibility.reason ?? PROPOSAL_GENERIC_MESSAGE
      })
      return
    }
    const kind = eligibility.kind
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
      setComposer((current) => (current === content ? '' : current))
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
      return
    }
    proposalDispatch({ type: 'proposal-started', workspaceId, sessionId, kind })
    if (kind === 'multi') {
      try {
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId })
        proposalDispatch({
          type: 'change-set-succeeded',
          workspaceId,
          sessionId,
          changeSet: outcome.changeSet
        })
      } catch (error: unknown) {
        proposalDispatch({
          type: 'proposal-failed',
          workspaceId,
          sessionId,
          message: normalizeChangeSetProposalError(error).message
        })
      }
      return
    }
    try {
      const outcome = await proposeAiFileChange({ workspaceId, sessionId })
      proposalDispatch({
        type: 'proposal-succeeded',
        workspaceId,
        sessionId,
        result: { transaction: outcome.transaction, summary: outcome.summary }
      })
    } catch (error: unknown) {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: normalizeProposalError(error, PROPOSAL_GENERIC_MESSAGE).message
      })
    }
  }

  /** Explicit retry: re-runs the proposal for the existing trailing user message. No resend. */
  async function handleRetryProposal(): Promise<void> {
    if (state.selectedSessionId === null || proposal.preparing || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    proposalDispatch({ type: 'proposal-retried', workspaceId, sessionId })
    if ((proposal.activeKind ?? 'single') === 'multi') {
      try {
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId })
        proposalDispatch({
          type: 'change-set-succeeded',
          workspaceId,
          sessionId,
          changeSet: outcome.changeSet
        })
      } catch (error: unknown) {
        proposalDispatch({
          type: 'proposal-failed',
          workspaceId,
          sessionId,
          message: normalizeChangeSetProposalError(error).message
        })
      }
      return
    }
    try {
      const outcome = await proposeAiFileChange({ workspaceId, sessionId })
      proposalDispatch({
        type: 'proposal-succeeded',
        workspaceId,
        sessionId,
        result: { transaction: outcome.transaction, summary: outcome.summary }
      })
    } catch (error: unknown) {
      proposalDispatch({
        type: 'proposal-failed',
        workspaceId,
        sessionId,
        message: normalizeProposalError(error, PROPOSAL_GENERIC_MESSAGE).message
      })
    }
  }

  function handleProposalMode(mode: ProposalMode): void {
    if (mode === proposal.mode) {
      return
    }
    proposalDispatch({ type: 'mode-changed', workspaceId, mode })
    if (mode === 'work' && state.selectedSessionId !== null) {
      void loadLatestWorkRun(state.selectedSessionId)
    }
  }

  /** Loads pending continuity for run-details display. Explicit and bounded. */
  async function loadSessionLooplink(sessionId: number): Promise<void> {
    looplinkDispatch({ type: 'continuity-loading', workspaceId, sessionId })
    try {
      const found = await getSessionLooplink({ workspaceId, sessionId })
      looplinkDispatch({ type: 'continuity-loaded', workspaceId, sessionId, looplink: found })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'continuity-failed',
        workspaceId,
        sessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load this continuity.'
      })
    }
  }

  /** Loads the pending Worker approval for a session. Explicit and bounded. */
  async function loadPendingApproval(sessionId: number): Promise<void> {
    try {
      const found = await getPendingWorkerApproval({ workspaceId, sessionId })
      setPendingApproval(found)
      setApprovalError(null)
    } catch (error: unknown) {
      setApprovalError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the pending approval.')
    }
  }

  async function handleApprovalDecision(approved: boolean): Promise<void> {
    if (state.selectedSessionId === null || pendingApproval === null || approvalActing) {
      return
    }
    const sessionId = state.selectedSessionId
    const approvalId = pendingApproval.id
    setApprovalActing(true)
    setApprovalError(null)
    try {
      const outcome = approved
        ? await approveWorkerApproval({ workspaceId, sessionId, approvalId })
        : await denyWorkerApproval({ workspaceId, sessionId, approvalId })
      await handleToolResumeOutcome(outcome, sessionId)
    } catch (error: unknown) {
      setApprovalError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t resolve this approval.')
    } finally {
      setApprovalActing(false)
    }
  }

  async function handleToolResumeOutcome(outcome: import('../../../../shared/ai/types').WorkRecoveryResult, sessionId: number): Promise<void> {
    if (!('kind' in outcome)) {
      return
    }
    if (outcome.kind === 'completed') {
      setPendingApproval(null)
      stickToBottomRef.current = true
      workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
      dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
      void loadSessionLooplink(sessionId)
      void loadLatestWorkRun(sessionId)
      return
    }
    if (outcome.kind === 'waiting_for_approval') {
      setPendingApproval(outcome.approval)
      void loadLatestWorkRun(sessionId)
      return
    }
    // Recovery handoffs from a pre-tool failure surface as safe copy.
    setPendingApproval(null)
    workDispatch({
      type: 'run-failed',
      workspaceId,
      sessionId,
      message: outcome.kind === 'recovery_handoff' && outcome.recoveryEvent.status === 'failed'
        ? 'Recovery attempt failed. No further automatic attempts will be made.'
        : 'STARK created a recovery session.'
    })
  }
  /** Loads the recovery event for a target session. Explicit and bounded. */
  async function loadRecoveryForSelected(sessionId: number): Promise<void> {
    try {
      const found = await getRecoveryForTarget({ workspaceId, sessionId })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: found })
    } catch (error: unknown) {
      recoveryDispatch({
        type: 'event-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the recovery state.'
      })
    }
  }

  async function handleDismissRecovery(): Promise<void> {
    if (state.selectedSessionId === null) {
      return
    }
    const sessionId = state.selectedSessionId
    try {
      const dismissed = await dismissRecovery({ workspaceId, sessionId })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: dismissed })
      void loadSessionLooplink(sessionId)
    } catch {
      recoveryDispatch({ type: 'event-failed', workspaceId, message: 'We couldn’t dismiss this recovery.' })
    }
  }

  /**
   * Explicit continuation: snapshots the selected source session into
   * a new target session with a pending handoff. Sends nothing and
   * starts no AI work — the target is selected for the user to read
   * and message explicitly.
   */
  async function handleContinueWithLooplink(): Promise<void> {
    if (state.selectedSessionId === null || looplink.acting || state.sending) {
      return
    }
    const sourceSessionId = state.selectedSessionId
    looplinkDispatch({ type: 'action-started', workspaceId, sessionId: sourceSessionId })
    try {
      const result = await createSessionContinuation({ workspaceId, sourceSessionId })
      dispatch({ type: 'session-created', session: result.targetSession })
      looplinkDispatch({ type: 'action-succeeded', workspaceId, sessionId: sourceSessionId, looplink: null })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'action-failed',
        workspaceId,
        sessionId: sourceSessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t prepare this continuity.'
      })
    }
  }

  /** Dismisses the selected session's pending continuity. No provider call. */
  async function handleDismissLooplink(): Promise<void> {
    if (state.selectedSessionId === null || looplink.acting) {
      return
    }
    const sessionId = state.selectedSessionId
    looplinkDispatch({ type: 'action-started', workspaceId, sessionId })
    try {
      const dismissed = await dismissSessionLooplink({ workspaceId, sessionId })
      looplinkDispatch({ type: 'action-succeeded', workspaceId, sessionId, looplink: dismissed })
    } catch (error: unknown) {
      looplinkDispatch({
        type: 'action-failed',
        workspaceId,
        sessionId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t dismiss this continuity.'
      })
    }
  }
  /** Loads the latest persisted run for run-details display. Explicit and bounded. */
  async function loadLatestWorkRun(sessionId: number): Promise<void> {
    try {
      const runs = await listRecentOrchestrationRuns({ workspaceId, sessionId })
      workDispatch({ type: 'runs-loaded', workspaceId, sessionId, run: runs[0] ?? null })
    } catch {
      // Run history is a convenience surface: a failed load only
      // leaves the previous details in place.
    }
  }

  /**
   * Work-mode send: persists the user message + explicit context
   * through the normal Stage 15 path, then runs one bounded Brain
   * orchestration for the persisted trailing message. The user
   * message stays on failure; nothing retries automatically.
   */
  async function handleWorkSend(sessionId: number, content: string): Promise<void> {
    if (work.preparing) {
      return
    }
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
      setComposer((current) => (current === content ? '' : current))
      contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
      return
    }
    workDispatch({ type: 'run-started', workspaceId, sessionId })
    try {
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId })
      if (!('kind' in outcome)) {
        const legacy = outcome as { run: never; session: never; message: never }
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: legacy.run as never })
        dispatch({ type: 'work-completed', workspaceId, session: legacy.session as never, message: legacy.message as never })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
        dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        setPendingApproval(null)
        return
      }
      if (outcome.kind === 'waiting_for_approval') {
        setPendingApproval(outcome.approval)
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.run })
        void loadSessionLooplink(sessionId)
        void loadLatestWorkRun(sessionId)
        return
      }
      if (outcome.kind === 'recovery_handoff' || outcome.kind === 'recovered') {
        dispatch({ type: 'session-created', session: outcome.targetSession })
        recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
        workDispatch({
          type: 'run-failed',
          workspaceId,
          sessionId,
          message: outcome.kind === 'recovery_handoff' && outcome.recoveryEvent.status === 'failed'
            ? 'Recovery attempt failed. No further automatic attempts will be made.'
            : 'STARK created a recovery session.'
        })
        dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
        void loadSessionLooplink(outcome.targetSession.id)
        void loadRecoveryForSelected(outcome.targetSession.id)
        return
      }
    } catch (error: unknown) {
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: normalizeBrainError(error, BRAIN_GENERIC_MESSAGE).message
      })
    }
  }

  /** Explicit Retry Work: reruns against the existing trailing user message. No resend. */
  async function handleRetryWork(): Promise<void> {
    if (state.selectedSessionId === null || work.preparing || state.sending) {
      return
    }
    const sessionId = state.selectedSessionId
    workDispatch({ type: 'run-retried', workspaceId, sessionId })
    try {
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId })
      if (!('kind' in outcome)) {
        const legacy = outcome as { run: never; session: never; message: never }
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: legacy.run as never })
        dispatch({ type: 'work-completed', workspaceId, session: legacy.session as never, message: legacy.message as never })
        void loadSessionLooplink(sessionId)
        return
      }
      if (outcome.kind === 'completed') {
        stickToBottomRef.current = true
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
        dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
        void loadSessionLooplink(sessionId)
        void loadRecoveryForSelected(outcome.result.session.id)
        setPendingApproval(null)
        return
      }
      if (outcome.kind === 'waiting_for_approval') {
        setPendingApproval(outcome.approval)
        workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.run })
        void loadSessionLooplink(sessionId)
        void loadLatestWorkRun(sessionId)
        return
      }
      dispatch({ type: 'session-created', session: outcome.targetSession })
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: outcome.recoveryEvent })
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: outcome.recoveryEvent.status === 'failed'
          ? 'Recovery attempt failed. No further automatic attempts will be made.'
          : 'STARK created a recovery session.'
      })
      dispatch({ type: 'session-selected', workspaceId, sessionId: outcome.targetSession.id })
      void loadSessionLooplink(outcome.targetSession.id)
      void loadRecoveryForSelected(outcome.targetSession.id)
    } catch (error: unknown) {
      workDispatch({
        type: 'run-failed',
        workspaceId,
        sessionId,
        message: normalizeBrainError(error, BRAIN_GENERIC_MESSAGE).message
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
  const eligibility = proposalEligibility(contextDrafts)
  const proposeMode = proposal.mode === 'propose'
  const workMode = proposal.mode === 'work'
  // loadingMessages gates sending: a latest page in flight must settle
  // first, otherwise its replace-on-arrive could drop a just-appended
  // message. Older-page loads only prepend, so they never clobber.
  // Propose mode additionally requires exactly one whole-file context;
  // Ask mode behavior is unchanged.
  const sendDisabled =
    state.selectedSessionId === null ||
    empty ||
    state.sending ||
    overLimit ||
    state.loadingMessages ||
    proposal.preparing ||
    work.preparing ||
    (proposeMode && !eligibility.eligible)
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
        <button
          className="explorer__secondary"
          type="button"
          onClick={() => void handleContinueWithLooplink()}
          disabled={state.selectedSessionId === null || looplink.acting || state.sending}
          aria-label="Continue with Looplink"
          title="Snapshot this session into a new continuation session"
        >
          {looplink.acting ? 'Preparing…' : 'Continue with Looplink'}
        </button>
      </div>
      {looplink.actionError !== null && (
        <p className="session__error" role="alert">
          {looplink.actionError}
        </p>
      )}
      {recovery.event !== null && (
        <div className="session__recovery" aria-label="Recovery handoff">
          <p className="session__status" role="status">
            {recoverySourceCopy(recovery.event.status)}
          </p>
          <p className="session__hint" role="note">
            {recoveryTargetCopy(recovery.event)}
          </p>
          {recovery.event.routes.length > 0 && (
            <ul className="session__list" aria-label="Recovery routes">
              {recovery.event.routes.map((route) => (
                <li key={route.role} className="session__message">
                  <span className="session__role">{route.role}</span>
                  <p className="session__content">
                    {route.providerId} / {route.model}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => handleSelect(recovery.event?.targetSessionId ?? 0)}
              disabled={(recovery.event?.targetSessionId ?? 0) === 0}
              aria-label="Open recovery session"
            >
              Open recovery session
            </button>
            {recovery.event.status === 'handoff_ready' && (
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => void handleDismissRecovery()}
                aria-label="Dismiss recovery"
              >
                Dismiss
              </button>
            )}
          </div>
          {recovery.eventError !== null && (
            <p className="session__error" role="alert">
              {recovery.eventError}
            </p>
          )}
        </div>
      )}
      {pendingApproval !== null && (
        <div className="session__recovery" aria-label="Worker approval">
          <p className="session__status" role="status">
            STARK Worker needs permission
          </p>
          <p className="session__hint" role="note">
            {pendingApproval.summary}
          </p>
          <p className="session__hint" role="note">
            This approval applies only to this exact action.
          </p>
          <div className="session__settings-row">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => void handleApprovalDecision(false)}
              disabled={approvalActing}
              aria-label="Deny approval"
            >
              Deny
            </button>
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleApprovalDecision(true)}
              disabled={approvalActing}
              aria-label="Approve approval"
            >
              {approvalActing ? 'Resolving…' : 'Approve'}
            </button>
          </div>
          {approvalError !== null && (
            <p className="session__error" role="alert">
              {approvalError}
            </p>
          )}
        </div>
      )}
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
          <div className="session__settings-row">
            <span className="session__eyebrow">Heart routing</span>
            <span className="session__hint">
              {heart.config === null ? 'Not configured' : heart.config.workerMode === 'fixed' ? 'Fixed' : 'Auto-Swap'}
            </span>
          </div>
          <p className="session__eyebrow">Brain model</p>
          <div className="session__settings-row">
            <select
              className="session__select"
              value={heart.draft.brain.providerId}
              onChange={(event) =>
                heartDispatch({
                  type: 'draft-edited',
                  workspaceId,
                  field: { scope: 'brain' },
                  providerId: event.target.value,
                  model: heart.draft.brain.model
                })
              }
              aria-label="Brain provider"
            >
              <option value="openai">openai</option>
            </select>
            <input
              className="session__field"
              value={heart.draft.brain.model}
              onChange={(event) =>
                heartDispatch({
                  type: 'draft-edited',
                  workspaceId,
                  field: { scope: 'brain' },
                  providerId: heart.draft.brain.providerId,
                  model: event.target.value
                })
              }
              placeholder="Brain model…"
              aria-label="Brain model"
              list="heart-model-options"
            />
          </div>
          <div className="session__composer-row" role="group" aria-label="Worker routing mode">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => heartDispatch({ type: 'mode-selected', workspaceId, mode: 'fixed' })}
              aria-pressed={heart.draft.workerMode === 'fixed'}
            >
              Fixed
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => heartDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_swap' })}
              aria-pressed={heart.draft.workerMode === 'auto_swap'}
            >
              Auto-Swap
            </button>
          </div>
          <p className="session__hint" role="note">
            Auto-Swap lets STARK Brain request a task profile. Heart maps that profile to one of your configured
            models. It does not retry failed models automatically.
          </p>
          {heart.draft.workerMode === 'fixed' ? (
            <>
              <p className="session__eyebrow">Worker model (Fixed)</p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={heart.draft.workerFixed.providerId}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerFixed' },
                      providerId: event.target.value,
                      model: heart.draft.workerFixed.model
                    })
                  }
                  aria-label="Fixed worker provider"
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={heart.draft.workerFixed.model}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerFixed' },
                      providerId: heart.draft.workerFixed.providerId,
                      model: event.target.value
                    })
                  }
                  placeholder="Worker model…"
                  aria-label="Fixed worker model"
                  list="heart-model-options"
                />
              </div>
            </>
          ) : (
            <>
              <p className="session__eyebrow">Default Worker model</p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={heart.draft.workerDefault.providerId}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerDefault' },
                      providerId: event.target.value,
                      model: heart.draft.workerDefault.model
                    })
                  }
                  aria-label="Default worker provider"
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={heart.draft.workerDefault.model}
                  onChange={(event) =>
                    heartDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope: 'workerDefault' },
                      providerId: heart.draft.workerDefault.providerId,
                      model: event.target.value
                    })
                  }
                  placeholder="Default worker model…"
                  aria-label="Default worker model"
                  list="heart-model-options"
                />
              </div>
              {(Object.keys(heart.draft.workerRoutes) as ('general' | 'coding' | 'reasoning' | 'fast')[]).map(
                (profile) => (
                  <div key={profile}>
                    <p className="session__eyebrow">{profile[0]?.toUpperCase() + profile.slice(1)} override (optional)</p>
                    <div className="session__settings-row">
                      <select
                        className="session__select"
                        value={heart.draft.workerRoutes[profile].providerId}
                        onChange={(event) =>
                          heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'route', profile },
                            providerId: event.target.value,
                            model: heart.draft.workerRoutes[profile].model
                          })
                        }
                        aria-label={`${profile} worker provider`}
                      >
                        <option value="openai">openai</option>
                      </select>
                      <input
                        className="session__field"
                        value={heart.draft.workerRoutes[profile].model}
                        onChange={(event) =>
                          heartDispatch({
                            type: 'draft-edited',
                            workspaceId,
                            field: { scope: 'route', profile },
                            providerId: heart.draft.workerRoutes[profile].providerId,
                            model: event.target.value
                          })
                        }
                        placeholder={`${profile} model… (optional)`}
                        aria-label={`${profile} worker model`}
                        list="heart-model-options"
                      />
                    </div>
                  </div>
                )
              )}
            </>
          )}
          <datalist id="heart-model-options">
            {provider.models.map((entry) => (
              <option key={entry.id} value={entry.id} />
            ))}
          </datalist>
          {heart.loading && (
            <p className="session__status" role="status">
              Loading Heart…
            </p>
          )}
          {heart.loadError !== null && (
            <p className="session__error" role="alert">
              {heart.loadError}
            </p>
          )}
          {heart.saveError !== null && (
            <p className="session__error" role="alert">
              {heart.saveError}
            </p>
          )}
          {heart.notice !== null && (
            <p className="session__status" role="status">
              {heart.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveHeart()}
              disabled={heart.saving}
            >
              {heart.saving ? 'Saving…' : 'Save Heart'}
            </button>
          </div>
          <div className="session__settings-row">
            <span className="session__eyebrow">Continuity Recovery</span>
          </div>
          <div className="session__composer-row" role="group" aria-label="Continuity recovery mode">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'off' })}
              aria-pressed={recovery.draft.mode === 'off'}
            >
              Off
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'handoff' })}
              aria-pressed={recovery.draft.mode === 'handoff'}
            >
              Handoff only
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => recoveryDispatch({ type: 'mode-selected', workspaceId, mode: 'auto_once' })}
              aria-pressed={recovery.draft.mode === 'auto_once'}
            >
              Auto once
            </button>
          </div>
          <p className="session__hint" role="note">
            {recovery.draft.mode === 'handoff'
              ? 'Create a Looplink recovery session after a recoverable provider failure, but do not call another model automatically.'
              : recovery.draft.mode === 'auto_once'
                ? 'Create one Looplink recovery session and make one attempt using your Recovery models. STARK will not retry or create another automatic handoff if that attempt fails.'
                : 'Recovery is off. Provider failures surface normally.'}
          </p>
          {(['ask', 'brain', 'worker'] as const).map((scope) => (
            <div key={scope}>
              <p className="session__eyebrow">
                {scope === 'ask' ? 'Ask Recovery' : scope === 'brain' ? 'Brain Recovery' : 'Worker Recovery'}
              </p>
              <div className="session__settings-row">
                <select
                  className="session__select"
                  value={recovery.draft[scope].providerId}
                  onChange={(event) =>
                    recoveryDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope },
                      providerId: event.target.value,
                      model: recovery.draft[scope].model
                    })
                  }
                  aria-label={`${scope} recovery provider`}
                >
                  <option value="openai">openai</option>
                </select>
                <input
                  className="session__field"
                  value={recovery.draft[scope].model}
                  onChange={(event) =>
                    recoveryDispatch({
                      type: 'draft-edited',
                      workspaceId,
                      field: { scope },
                      providerId: recovery.draft[scope].providerId,
                      model: event.target.value
                    })
                  }
                  placeholder={`${scope} recovery model…`}
                  aria-label={`${scope} recovery model`}
                  list="recovery-model-options"
                />
              </div>
            </div>
          ))}
          <datalist id="recovery-model-options">
            {provider.models.map((entry) => (
              <option key={entry.id} value={entry.id} />
            ))}
          </datalist>
          {recovery.loading && (
            <p className="session__status" role="status">
              Loading recovery…
            </p>
          )}
          {recovery.loadError !== null && (
            <p className="session__error" role="alert">
              {recovery.loadError}
            </p>
          )}
          {recovery.saveError !== null && (
            <p className="session__error" role="alert">
              {recovery.saveError}
            </p>
          )}
          {recovery.notice !== null && (
            <p className="session__status" role="status">
              {recovery.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveRecovery()}
              disabled={recovery.saving}
            >
              {recovery.saving ? 'Saving…' : 'Save Recovery'}
            </button>
          </div>
          <div className="session__settings-row">
            <span className="session__eyebrow">Agent Permissions</span>
            <span className="session__hint">{capabilities.draft.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <p className="session__hint" role="note">
            Permissions only control whether future STARK Worker tools may request an action. They do not bypass
            Workspace security or human review.
          </p>
          <div className="session__settings-row">
            <span className="session__eyebrow">Workspace Agent Capabilities</span>
          </div>
          <div className="session__composer-row" role="group" aria-label="Workspace agent capabilities">
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: false })}
              aria-pressed={!capabilities.draft.enabled}
            >
              Disabled
            </button>
            <button
              className="explorer__secondary"
              type="button"
              onClick={() => capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: true })}
              aria-pressed={capabilities.draft.enabled}
            >
              Enabled
            </button>
          </div>
          <div aria-disabled={!capabilities.draft.enabled}>
            {CAPABILITY_ORDER.map((capability) => (
              <div key={capability}>
                <p className="session__eyebrow">{capabilityLabel(capability)}</p>
                <div className="session__composer-row" role="group" aria-label={`${capability} permission`}>
                  {legalModesFor(capability).map((mode) => (
                    <button
                      key={mode}
                      className="explorer__secondary"
                      type="button"
                      onClick={() => capabilitiesDispatch({ type: 'mode-selected', workspaceId, capability, mode })}
                      aria-pressed={capabilities.draft.modes[capability] === mode}
                      disabled={!capabilities.draft.enabled}
                    >
                      {mode === 'deny' ? 'Deny' : mode === 'ask' ? 'Ask' : 'Allow'}
                    </button>
                  ))}
                </div>
                {capability === 'terminal.execute' && (
                  <p className="session__hint" role="note">
                    Terminal execution always requires approval for the exact command.
                  </p>
                )}
                {capability === 'change.propose' && (
                  <p className="session__hint" role="note">
                    Allowing proposals does not allow STARK to apply them. File changes still require review and Accept.
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="session__hint" role="note">
            STARK must ask before each future action.
          </p>
          {capabilities.loading && (
            <p className="session__status" role="status">
              Loading permissions…
            </p>
          )}
          {capabilities.loadError !== null && (
            <p className="session__error" role="alert">
              {capabilities.loadError}
            </p>
          )}
          {capabilities.saveError !== null && (
            <p className="session__error" role="alert">
              {capabilities.saveError}
            </p>
          )}
          {capabilities.notice !== null && (
            <p className="session__status" role="status">
              {capabilities.notice}
            </p>
          )}
          <div className="session__settings-row">
            <button
              className="explorer__primary"
              type="button"
              onClick={() => void handleSaveCapabilities()}
              disabled={capabilities.saving}
            >
              {capabilities.saving ? 'Saving…' : 'Save permissions'}
            </button>
          </div>
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
          {looplink.loading && (
            <p className="session__status" role="status">
              Loading continuity…
            </p>
          )}
          {looplink.loadError !== null && (
            <p className="session__error" role="alert">
              {looplink.loadError}
            </p>
          )}
          {looplink.looplink !== null && (
            <div className="session__context" aria-label="Looplink continuity">
              <div className="session__context-header">
                <p className="session__eyebrow">Looplink</p>
                <span className="session__hint">Status: {looplink.looplink.status}</span>
              </div>
              <p className="session__status">
                Continuing from: {looplink.looplink.sourceTitle}
              </p>
              {looplink.looplink.payload.omissions.messageCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.messageCount} older messages omitted to stay within the
                  continuity limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.contextCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.contextCount} older context items omitted to stay within the
                  continuity limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.workerResultOmitted && (
                <p className="session__hint" role="status">
                  Worker result omitted because it exceeded the Looplink limit.
                </p>
              )}
              {looplink.looplink.payload.omissions.changeCount > 0 && (
                <p className="session__hint" role="status">
                  {looplink.looplink.payload.omissions.changeCount} older change references omitted to stay within the
                  continuity limit.
                </p>
              )}
              <ul className="session__context-list">
                {looplink.looplink.payload.messages.map((entry, index) => (
                  <li key={index}>
                    <ContextCard
                      label={entry.role === 'assistant' ? 'STARK (historical)' : 'You (historical)'}
                      detail="history"
                      content={entry.content}
                      removable={false}
                    />
                  </li>
                ))}
                {looplink.looplink.payload.explicitContext.map((entry, index) => (
                  <li key={`ctx-${String(index)}`}>
                    <ContextCard
                      label={`Historical context snapshot · ${entry.label}`}
                      detail={entry.kind}
                      content={entry.content}
                      removable={false}
                    />
                  </li>
                ))}
              </ul>
              {looplink.looplink.payload.orchestration !== null && (
                <p className="session__status">
                  Latest plan: {looplink.looplink.payload.orchestration.planSummary ?? looplink.looplink.payload.orchestration.status}
                </p>
              )}
              {looplink.looplink.status === 'pending' && (
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => void handleDismissLooplink()}
                  disabled={looplink.acting}
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
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
            {work.preparing && (
              <p className="session__status" role="status">
                Brain is working…
              </p>
            )}
            {work.error !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{work.error}</p>
                <button className="explorer__secondary" type="button" onClick={() => void handleRetryWork()}>
                  Retry Work
                </button>
              </div>
            )}
            {work.run !== null && (
              <div className="session__generation-error" role="status" aria-label="Work run details">
                <p className="session__status">
                  Work run · {work.run.status}
                  {work.run.action !== null ? ` · ${work.run.action}` : ''}
                </p>
                {work.run.planSummary !== null && <p className="session__status">Plan: {work.run.planSummary}</p>}
                <ul className="session__context-list">
                  {work.run.steps.map((step) => (
                    <li key={step.id}>
                      <span className="session__hint">
                        {step.kind === 'brain_plan' ? 'Brain Plan' : step.kind === 'worker' ? 'Worker result' : 'Brain Final response'} · {step.status}
                        {step.modelAudit !== null
                          ? ` · ${step.modelAudit.providerId} / ${step.modelAudit.model}`
                          : ' · Model information unavailable for this older run.'}
                      </span>
                      {step.kind === 'worker' && (
                        <span className="session__hint">
                          {step.modelAudit !== null && step.modelAudit.requestedProfile !== null
                            ? `Requested profile: ${step.modelAudit.requestedProfile} · Resolved route: ${step.modelAudit.routeKey}`
                            : 'Route: Fixed'}
                        </span>
                      )}
                      {step.kind === 'worker' && step.output !== null && (
                        <ContextCard label="Worker result" detail={step.status} content={step.output} removable={false} />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            <div className="session__composer-row" role="group" aria-label="Composer mode">
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => handleProposalMode('ask')}
                aria-pressed={proposal.mode === 'ask'}
                disabled={proposal.preparing || work.preparing}
              >
                Ask
              </button>
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => handleProposalMode('work')}
                aria-pressed={proposal.mode === 'work'}
                disabled={proposal.preparing || work.preparing}
              >
                Work
              </button>
              <button
                className="explorer__secondary"
                type="button"
                onClick={() => handleProposalMode('propose')}
                aria-pressed={proposal.mode === 'propose'}
                disabled={proposal.preparing || work.preparing}
              >
                Propose change
              </button>
            </div>
            {proposeMode && !eligibility.eligible && (
              <p className="session__hint" role="status">
                {eligibility.reason ?? 'Attach one or more whole files to propose code changes.'}
              </p>
            )}
            {proposal.preparing && (
              <p className="session__status" role="status">
                STARK is preparing a change…
              </p>
            )}
            {proposal.error !== null && (
              <div className="session__generation-error" role="alert">
                <p className="session__error">{proposal.error}</p>
                <button className="explorer__secondary" type="button" onClick={() => void handleRetryProposal()}>
                  Retry proposal
                </button>
              </div>
            )}
            {proposal.result !== null && (
              <div className="session__generation-error" role="status" aria-label="Code proposal ready">
                <p className="session__status">
                  Proposal ready · {proposal.result.transaction.files[0]?.relativePath ?? 'file'} ·{' '}
                  {proposal.result.summary}
                </p>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onReviewTransaction(proposal.result?.transaction.id ?? 0)}
                >
                  Review change
                </button>
              </div>
            )}
            {proposal.changeSet !== null && (
              <div className="session__generation-error" role="status" aria-label="Grouped code proposal ready">
                <p className="session__status">
                  Proposal ready · {proposal.changeSet.changeSet.items.length} files ·{' '}
                  {proposal.changeSet.changeSet.summary}
                </p>
                <ul className="session__context-list">
                  {proposal.changeSet.changeSet.items.map((item) => (
                    <li key={item.transaction.id}>
                      <span className="session__hint">
                        - {item.transaction.files[0]?.relativePath ?? 'file'}
                      </span>
                    </li>
                  ))}
                </ul>
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onReviewChangeSet(proposal.changeSet?.changeSet.id ?? 0)}
                >
                  Review change set
                </button>
              </div>
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
              disabled={state.sending || proposal.preparing || work.preparing}
            />
            <div className="session__composer-row">
              <p className="session__hint">
                {proposeMode
                  ? 'Propose change creates pending transactions — one file, or a grouped change set. A human must review and accept each file.'
                  : workMode
                    ? `Work runs a bounded Brain orchestration with at most one Worker step. Heart: ${heart.config === null ? 'not configured' : heart.config.workerMode === 'fixed' ? 'Fixed' : 'Auto-Swap'}`
                    : aiReady
                      ? 'Stored locally. STARK will reply.'
                      : 'Stored locally. No AI reply yet.'}
              </p>
              <button
                className="explorer__primary"
                type="button"
                onClick={() => void handleSend()}
                disabled={sendDisabled}
              >
                {state.sending ? 'Sending…' : proposal.preparing || work.preparing ? 'Preparing…' : 'Send'}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
