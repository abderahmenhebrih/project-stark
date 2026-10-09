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
import { StarkSettingsSurface, type SettingsSection } from './StarkSettingsSurface'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { StarkMark } from '../../components/StarkMark'
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
import {
  getActiveRuntime,
  listRecentRuntimes,
  openRuntimePreview,
  reloadRuntimePreview,
  stopRuntime,
  subscribeRuntimeUpdates
} from '../../lib/runtimes-api'
import type { ProjectRuntimeSummary } from '../../../../shared/project-runtime/types'
import { PREVIEW_TRUNCATION_NOTICE, initialRuntimePanelState, runtimePanelReducer, runtimeStatusLabel } from './runtime-state'
import type { WorkerToolApproval } from '../../../../shared/worker-tools/types'
import { getUsageConfig, getUsageSummary, saveUsageConfig } from '../../lib/usage-api'
import { USAGE_ROUTE_KEYS, initialUsagePanelState, usagePanelReducer } from './usage-state'
import { getWorkspaceCapabilityConfig, saveWorkspaceCapabilityConfig } from '../../lib/capabilities-api'
import {
  CAPABILITY_ORDER,
  initialCapabilityPanelState,
  capabilityPanelReducer
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
  readonly contextDrafts: readonly SessionContextDraft[]
  readonly contextDraftsDispatch: Dispatch<SessionContextDraftAction>
  readonly contextDraftError: string | null
  readonly onReviewTransaction: (transactionId: number) => void
  readonly onReviewChangeSet: (changeSetId: number) => void
  /** Dedicated settings surface visibility (owned by the shell so AppChrome can reach it). */
  readonly settingsOpen: boolean
  readonly settingsSection: SettingsSection
  readonly onSettingsSectionChange: (section: SettingsSection) => void
  readonly onCloseSettings: () => void
  /** Reveal the secondary Context tab (owned by the Explorer). */
  readonly onOpenContext: () => void
  /**
   * Mirror the active-session chrome (title, history, busy flags) up to
   * the shell so AppChrome can render the session tab strip. The
   * reducer here stays the single source of truth; the shell only
   * displays the snapshot and forwards the actions back unchanged.
   */
  readonly onSessionChrome: (snapshot: SessionChromeSnapshot, actions: SessionChromeActions) => void
}

/** Minimal session identity for the AppChrome tab strip + history menu. */
export interface SessionChromeSession {
  readonly id: number
  readonly title: string
}

/** Display snapshot mirrored to the shell; reducer state stays canonical. */
export interface SessionChromeSnapshot {
  readonly title: string
  readonly sessions: readonly SessionChromeSession[]
  readonly selectedSessionId: number | null
  readonly sessionsLoading: boolean
  readonly looplinkActing: boolean
  readonly sendBusy: boolean
}

/** Existing session actions forwarded to the shell unchanged. */
export interface SessionChromeActions {
  readonly newSession: () => void
  readonly selectSession: (sessionId: number) => void
  readonly continueLooplink: () => void
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
  contextDrafts,
  contextDraftsDispatch,
  contextDraftError,
  onReviewTransaction,
  onReviewChangeSet,
  settingsOpen,
  settingsSection,
  onSettingsSectionChange,
  onCloseSettings,
  onOpenContext,
  onSessionChrome
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
  const [usage, usageDispatch] = useReducer(usagePanelReducer, workspaceId, (id) => ({
    ...initialUsagePanelState(),
    workspaceId: id
  }))
  const [runtime, runtimeDispatch] = useReducer(runtimePanelReducer, workspaceId, (id) => ({
    ...initialRuntimePanelState(),
    workspaceId: id
  }))
  const [pendingApproval, setPendingApproval] = useState<WorkerToolApproval | null>(null)
  const [approvalActing, setApprovalActing] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
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

  function parseOptionalCount(text: string, what: string): number | null {
    const trimmed = text.trim()
    if (trimmed === '') {
      return null
    }
    if (!/^[0-9]+$/.test(trimmed)) {
      throw new Error(`The usage routing ${what} must be a whole number or empty.`)
    }
    const value = Number(trimmed)
    if (!Number.isSafeInteger(value)) {
      throw new Error(`The usage routing ${what} is invalid.`)
    }
    return value
  }

  async function refreshUsageConfig(targetWorkspaceId: number): Promise<void> {
    usageDispatch({ type: 'config-loading', workspaceId: targetWorkspaceId })
    try {
      const config = await getUsageConfig()
      usageDispatch({ type: 'config-loaded', workspaceId: targetWorkspaceId, config })
    } catch (error: unknown) {
      usageDispatch({
        type: 'config-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the usage configuration.'
      })
    }
  }

  async function refreshUsageSummary(targetWorkspaceId: number): Promise<void> {
    usageDispatch({ type: 'summary-loading', workspaceId: targetWorkspaceId })
    try {
      const summary = await getUsageSummary()
      usageDispatch({ type: 'summary-loaded', workspaceId: targetWorkspaceId, summary })
    } catch (error: unknown) {
      usageDispatch({
        type: 'summary-failed',
        workspaceId: targetWorkspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the local usage summary.'
      })
    }
  }

  async function handleSaveUsage(): Promise<void> {
    if (usage.saving) {
      return
    }
    const draft = usage.draft
    usageDispatch({ type: 'save-started', workspaceId })
    try {
      const limits = draft.limits.map((entry) => {
        if (entry.model.trim() === '') {
          throw new Error('Each usage routing limit needs a model.')
        }
        const maxCalls24h = parseOptionalCount(entry.maxCalls, 'call limit')
        const maxTotalTokens24h = parseOptionalCount(entry.maxTokens, 'token limit')
        const switchText = entry.switchAt.trim()
        if (!/^[0-9]+$/.test(switchText)) {
          throw new Error('The usage routing switch percentage must be a whole number from 1 to 100.')
        }
        return {
          providerId: entry.providerId,
          model: entry.model.trim(),
          maxCalls24h,
          maxTotalTokens24h,
          switchAtPercent: Number(switchText)
        }
      })
      const config = await saveUsageConfig({
        heartThresholdRoutingEnabled: draft.thresholdRoutingEnabled,
        limits,
        alternates: USAGE_ROUTE_KEYS.filter((routeKey) => draft.alternates[routeKey].model.trim() !== '').map(
          (routeKey) => ({
            routeKey,
            providerId: draft.alternates[routeKey].providerId,
            model: draft.alternates[routeKey].model.trim()
          })
        )
      })
      usageDispatch({ type: 'save-succeeded', workspaceId, config })
    } catch (error: unknown) {
      usageDispatch({
        type: 'save-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t save the usage routing configuration.'
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
    usageDispatch({ type: 'workspace-changed', workspaceId })
    void refreshHeartConfig(workspaceId)
    void refreshRecoveryConfig(workspaceId)
    void refreshCapabilityConfig(workspaceId)
    void refreshUsageConfig(workspaceId)
    void refreshUsageSummary(workspaceId)
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

  // Managed project runtimes are workspace-scoped and live outside any
  // single session: load explicitly on mount and reflect main-pushed
  // updates with no polling and no timers.
  useEffect(() => {
    void loadActiveRuntime()
    void loadRecentRuntimes()
    const unsubscribe = subscribeRuntimeUpdates((event) => {
      if (event.workspaceId !== workspaceId) {
        return
      }
      runtimeDispatch({ type: 'updated', workspaceId, active: event.runtime })
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

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

  /** Loads the active managed runtime for the workspace. Explicit and bounded. */
  async function loadActiveRuntime(): Promise<void> {
    try {
      const found = await getActiveRuntime({ workspaceId })
      runtimeDispatch({ type: 'active-loaded', workspaceId, active: found })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the project runtime.'
      })
    }
  }

  /** Loads recent runtime history for the workspace. Explicit and bounded. */
  async function loadRecentRuntimes(): Promise<void> {
    try {
      const found = await listRecentRuntimes({ workspaceId })
      runtimeDispatch({ type: 'history-loaded', workspaceId, history: found })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t load the project runtime.'
      })
    }
  }

  /** Explicit human Stop: terminates exactly the tracked runtime tree. No AI approval involved. */
  async function handleStopRuntime(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const stopped = await stopRuntime({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: stopped.status === 'stopped' ? null : stopped })
      void loadRecentRuntimes()
      void loadActiveRuntime()
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t stop the project runtime.'
      })
    }
  }

  /** Opens the isolated Live Preview for a running runtime. Main derives the URL. */
  async function handleOpenPreview(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const current = await openRuntimePreview({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: current })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t open the live preview.'
      })
    }
  }

  /** Reloads the open preview window. No URL is ever submitted. */
  async function handleReloadPreview(runtimeId: number): Promise<void> {
    if (runtime.acting) {
      return
    }
    runtimeDispatch({ type: 'action-started', workspaceId })
    try {
      const current = await reloadRuntimePreview({ workspaceId, runtimeId })
      runtimeDispatch({ type: 'action-succeeded', workspaceId, active: current })
    } catch (error: unknown) {
      runtimeDispatch({
        type: 'action-failed',
        workspaceId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t reload the live preview.'
      })
    }
  }

  async function handleApprovalDecision(approved: boolean): Promise<void> {
    if (state.selectedSessionId === null || pendingApproval === null || approvalActing) {
      return
    }
    const sessionId = state.selectedSessionId
    const approvalId = pendingApproval.id
    const wasRuntimeStart = pendingApproval.toolName === 'runtime_start'
    setApprovalActing(true)
    setApprovalError(null)
    try {
      const outcome = approved
        ? await approveWorkerApproval({ workspaceId, sessionId, approvalId })
        : await denyWorkerApproval({ workspaceId, sessionId, approvalId })
      await handleToolResumeOutcome(outcome, sessionId)
      if (wasRuntimeStart) {
        void loadActiveRuntime()
        void loadRecentRuntimes()
      }
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

  // Mirror session chrome state to the shell tab strip. The reducer
  // above stays canonical; HomePage only displays the snapshot and
  // forwards actions back, so there is exactly one state owner.
  // Handler identities are intentionally excluded below: the effect
  // re-mirrors only when display inputs change, always forwarding the
  // latest handlers by closure.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    onSessionChrome(
      {
        title: selectedSession?.title ?? 'New session',
        sessions: state.sessions.map((entry) => ({ id: entry.id, title: entry.title })),
        selectedSessionId: state.selectedSessionId,
        sessionsLoading: state.loadingSessions,
        looplinkActing: looplink.acting,
        sendBusy: state.sending
      },
      {
        newSession: () => void handleNew(),
        selectSession: (sessionId: number) => handleSelect(sessionId),
        continueLooplink: () => void handleContinueWithLooplink()
      }
    )
  }, [
    onSessionChrome,
    selectedSession?.title,
    state.sessions,
    state.selectedSessionId,
    state.loadingSessions,
    state.sending,
    looplink.acting
  ])
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <section className="session" aria-label="STARK Session">
      {looplink.actionError !== null && (
        <p className="session__error" role="alert">
          {looplink.actionError}
        </p>
      )}
      <p className="session__notice" role="status">
        {aiReady ? `OpenAI · ${provider.selectedModel ?? ''}` : 'Local session — AI provider not connected yet.'}
      </p>
      {settingsOpen && (
        <StarkSettingsSurface
          workspaceId={workspaceId}
          section={settingsSection}
          onSectionChange={onSettingsSectionChange}
          onClose={onCloseSettings}
          provider={provider}
          apiKeyInput={apiKeyInput}
          onApiKeyInputChange={setApiKeyInput}
          revealKey={revealKey}
          onToggleRevealKey={() => setRevealKey((reveal) => !reveal)}
          modelValue={modelValue}
          selectedModelMissing={selectedModelMissing}
          useModelDisabled={modelDraft === null || modelDraft === provider.selectedModel}
          onModelDraftChange={setModelDraft}
          onSaveKey={() => void handleSaveKey()}
          onRemoveKey={() => void handleRemoveKey()}
          onTestConnection={() => void handleTestConnection()}
          onRefreshModels={() => void handleRefreshModels()}
          onUseModel={() => void handleUseModel()}
          heart={heart}
          heartDispatch={heartDispatch}
          onSaveHeart={() => void handleSaveHeart()}
          recovery={recovery}
          recoveryDispatch={recoveryDispatch}
          onSaveRecovery={() => void handleSaveRecovery()}
          usage={usage}
          usageDispatch={usageDispatch}
          onRefreshUsageSummary={() => void refreshUsageSummary(workspaceId)}
          onSaveUsage={() => void handleSaveUsage()}
          capabilities={capabilities}
          capabilitiesDispatch={capabilitiesDispatch}
          onSaveCapabilities={() => void handleSaveCapabilities()}
        />
      )}
      {/* All provider, Heart, Recovery, usage, and capability settings live in StarkSettingsSurface. */}
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
                    <span className="session__role-row">
                      {message.role === 'assistant' && <StarkMark size="bar" />}
                      <span className="session__role">{roleLabel(message.role)}</span>
                    </span>
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
          {(recovery.event !== null ||
            pendingApproval !== null ||
            runtime.active !== null ||
            runtime.history.length > 0 ||
            work.preparing ||
            work.error !== null ||
            work.run !== null) && (
            <div className="session__dock" aria-label="Pending actions">
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
                    {pendingApproval.toolName === 'change_propose' ? 'Worker wants to create a reviewable proposal.' : 'STARK Worker needs permission'}
                  </p>
                  {pendingApproval.toolName === 'terminal_execute' && (
                    <p className="session__hint" role="note">
                      Capability: Terminal command
                    </p>
                  )}
                  {pendingApproval.toolName === 'runtime_start' && (
                    <p className="session__hint" role="note">
                      Capability: Project runtime
                    </p>
                  )}
                  {pendingApproval.toolName === 'runtime_observe' && (
                    <p className="session__hint" role="note">
                      Capability: Runtime observation
                    </p>
                  )}
                  {pendingApproval.toolName === 'preview_inspect' && (
                    <p className="session__hint" role="note">
                      Capability: Live Preview inspection
                    </p>
                  )}
                  {pendingApproval.toolName === 'runtime_observe' && (
                    <p className="session__hint" role="note">
                      Action: Observe managed runtime
                    </p>
                  )}
                  {pendingApproval.toolName === 'preview_inspect' && (
                    <p className="session__hint" role="note">
                      Action: Inspect rendered Live Preview
                    </p>
                  )}
                  <p className="session__hint" role="note">
                    {pendingApproval.summary}
                  </p>
                  <p className="session__hint" role="note">
                    {pendingApproval.toolName === 'change_propose'
                      ? 'Approval creates a reviewable proposal only. Files will not change until you review and Accept them.'
                      : pendingApproval.toolName === 'terminal_execute'
                        ? 'This exact command will run with your user account from the Workspace root. It may modify files, start subprocesses, or access the network.'
                        : pendingApproval.toolName === 'runtime_start'
                          ? 'This exact command will run with your user account from the Workspace root and may modify files, start subprocesses, or access the network.'
                          : pendingApproval.toolName === 'runtime_observe'
                            ? 'This approval allows STARK Worker to read the current managed runtime state and bounded logs once. This approval does not allow STARK Worker to stop, restart, or modify the runtime.'
                            : pendingApproval.toolName === 'preview_inspect'
                              ? 'STARK Worker may inspect bounded rendered content from this local Preview once. STARK does not click, type, submit forms, or modify the DOM. If needed, STARK may load this approved local Preview path in an isolated inspection window.'
                              : 'This approval applies only to this exact action.'}
                  </p>
                  {pendingApproval.toolName === 'runtime_start' && (
                    <>
                      <p className="session__hint" role="note">
                        This runtime may remain active for up to 30 minutes.
                      </p>
                      <p className="session__hint" role="note">
                        This approval applies only to this exact program, arguments, and preview port.
                      </p>
                    </>
                  )}
                  {pendingApproval.toolName === 'terminal_execute' && (
                    <p className="session__hint" role="note">
                      This approval applies only to this exact program and argument list.
                    </p>
                  )}
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
                      className="explorer__primary session__approve"
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
              {(runtime.active !== null || runtime.history.length > 0) && (
                <div className="session__recovery" aria-label="Project runtime">
                  <p className="session__status" role="status">
                    {runtime.active !== null
                      ? `${runtimeStatusLabel(runtime.active.status)} · port ${runtime.active.previewPort}`
                      : `Last run · ${runtime.history[0]?.program ?? 'runtime'} · port ${runtime.history[0]?.previewPort ?? ''} · ${runtimeStatusLabel(runtime.history[0]?.status ?? 'exited')}`}
                  </p>
                  {runtime.active !== null && (
                    <div className="session__settings-row">
                      <button
                        className="explorer__secondary"
                        type="button"
                        onClick={() => void handleOpenPreview(runtime.active?.id ?? 0)}
                        disabled={runtime.acting || runtime.active.status !== 'running'}
                        aria-label="Open preview"
                      >
                        Open Preview
                      </button>
                      <button
                        className="explorer__secondary"
                        type="button"
                        onClick={() => void handleStopRuntime(runtime.active?.id ?? 0)}
                        disabled={runtime.acting || (runtime.active.status !== 'running' && runtime.active.status !== 'starting')}
                        aria-label="Stop runtime"
                      >
                        Stop Runtime
                      </button>
                    </div>
                  )}
                  <details className="session__runtime-details">
                    <summary className="session__eyebrow">Runtime details</summary>
                    {runtime.active !== null && (
                      <>
                        <p className="session__hint" role="note">
                          Command: {runtime.active.program}{runtime.active.args.length > 0 ? ` ${runtime.active.args.join(' ')}` : ''}
                        </p>
                        <p className="session__hint" role="note">
                          Preview: {runtime.active.previewUrl}
                        </p>
                        <p className="session__hint" role="note">
                          Started: {formatTime(runtime.active.startedAt ?? runtime.active.createdAt)} · Maximum runtime: 30 minutes.
                        </p>
                        <div className="session__settings-row">
                          <button
                            className="explorer__secondary"
                            type="button"
                            onClick={() => void handleReloadPreview(runtime.active?.id ?? 0)}
                            disabled={runtime.acting || runtime.active.status !== 'running'}
                            aria-label="Reload preview"
                          >
                            Reload Preview
                          </button>
                        </div>
                        {(runtime.active.stdoutTail !== '' || runtime.active.stderrTail !== '') && (
                          <>
                            <p className="session__eyebrow">Runtime output</p>
                            {runtime.active.stdoutTail !== '' && (
                              <pre className="session__hint" aria-label="Runtime stdout">{runtime.active.stdoutTail}</pre>
                            )}
                            {runtime.active.stderrTail !== '' && (
                              <pre className="session__hint" aria-label="Runtime stderr">{runtime.active.stderrTail}</pre>
                            )}
                            {runtime.active.logsTruncated && (
                              <p className="session__hint" role="note">
                                Older runtime output was omitted.
                              </p>
                            )}
                          </>
                        )}
                        <details aria-label="Worker observation details">
                          <summary className="session__eyebrow">Worker observation details</summary>
                          <p className="session__hint" role="note">
                            Runtime observation: Observed runtime state and bounded logs appear in Work run details as inert text.
                          </p>
                          <p className="session__hint" role="note">
                            Live Preview inspection: Page title, loopback URL, rendered text, and bounded element list appear in Work run details as inert text. No input values are shown.
                          </p>
                          <p className="session__hint" role="note">
                            {PREVIEW_TRUNCATION_NOTICE}
                          </p>
                        </details>
                      </>
                    )}
                    {runtime.history.length > 0 && (
                      <>
                        <p className="session__eyebrow">Recent runtimes</p>
                        <ul className="session__context-list">
                          {runtime.history.map((entry: ProjectRuntimeSummary) => (
                            <li key={entry.id}>
                              <span className="session__hint">
                                {entry.program} · port {entry.previewPort} · {runtimeStatusLabel(entry.status)}
                                {entry.stopReason !== null ? ` · ${entry.stopReason}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {runtime.error !== null && (
                      <p className="session__error" role="alert">
                        {runtime.error}
                      </p>
                    )}
                  </details>
                </div>
              )}
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
                  {work.run.usageRouteDecisions.map((decision, index) => (
                    <p className="session__hint" role="note" key={`${decision.role}-${decision.routeKey}-${String(index)}`}>
                      {decision.decision === 'threshold_alternate'
                        ? `${decision.role === 'brain' ? 'Brain' : 'Worker'} — Configured: ${decision.baseProviderId} / ${decision.baseModel} — Threshold route: ${decision.selectedProviderId} / ${decision.selectedModel} — Reason: Local call threshold reached`
                        : decision.decision === 'threshold_reached_no_alternate'
                          ? 'Local threshold reached; normal Heart route used because no alternate is configured.'
                          : null}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className={`session__composer session__composer--${proposal.mode}`}>
            {(contextDrafts.length > 0 || contextDraftError !== null) && (
              <div className="session__context-chips" aria-label="Attached context summary">
                <button
                  className="session__context-count"
                  type="button"
                  onClick={onOpenContext}
                  aria-label={`Open attached context, ${contextDrafts.length} items`}
                  title="Open Context tab"
                >
                  Context · {contextDrafts.length}
                </button>
                {contextDrafts.slice(0, 4).map((draft) => (
                  <span
                    key={draft.draftId}
                    className={
                      draft.kind === 'manual-note'
                        ? 'session__chip session__chip--note'
                        : 'session__chip'
                    }
                    title={draft.label}
                  >
                    <span className="session__chip-label">{draft.label}</span>
                    <button
                      className="session__chip-remove"
                      type="button"
                      onClick={() => handleRemoveDraft(draft.draftId)}
                      aria-label={`Remove ${draft.label}`}
                      title={`Remove ${draft.label}`}
                    >
                      <StarkIcon name="close" size={12} />
                    </button>
                  </span>
                ))}
                {contextDrafts.length > 4 && (
                  <button
                    className="session__context-count"
                    type="button"
                    onClick={onOpenContext}
                    aria-label={`Open attached context, ${contextDrafts.length - 4} more items`}
                  >
                    +{contextDrafts.length - 4} more
                  </button>
                )}
              </div>
            )}
            {contextDraftError !== null && (
              <p className="session__error" role="alert">
                {contextDraftError}
              </p>
            )}
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
                className="explorer__secondary session__mode session__mode--ask"
                type="button"
                onClick={() => handleProposalMode('ask')}
                aria-pressed={proposal.mode === 'ask'}
                disabled={proposal.preparing || work.preparing}
              >
                Ask
              </button>
              <button
                className="explorer__secondary session__mode session__mode--work"
                type="button"
                onClick={() => handleProposalMode('work')}
                aria-pressed={proposal.mode === 'work'}
                disabled={proposal.preparing || work.preparing}
              >
                Work
              </button>
              <button
                className="explorer__secondary session__mode session__mode--propose"
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
                className="explorer__primary session__send"
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
