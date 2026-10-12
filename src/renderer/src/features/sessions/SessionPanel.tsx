import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import { SponsoredWorkingSlot } from '../monetization/sponsored-working/SponsoredWorkingSlot'
import { NullSponsorProvider } from '../monetization/sponsored-working/sponsor-provider'
import { buildAiRunId, deriveAiRunState } from '../monetization/sponsored-working/sponsor-lifecycle'
import type { CodingMessage } from '../../../../shared/sessions/types'
import type { SessionContextDraft } from '../../../../shared/context/types'
import type { ChatAttachment } from '../../../../shared/chat-attachments/types'
import {
  createCodingSession,
  listCodingSessions,
  listSessionMessages,
  sendSessionUserMessage
} from '../../lib/sessions-api'
import { chooseChatAttachments, removeChatAttachmentDraft } from '../../lib/attachments-api'
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
import { createPortal } from 'react-dom'
import { SettingsPage } from '../settings/SettingsPage'
import type { SettingsSection } from '../settings/settings-section'
import { UiIcon } from '../../components/icons/UiIcon'
import { StarkMark } from '../../components/StarkMark'
import type { ExtensionAgentProviderInfo } from '../../../../shared/extension-agents/types'
import { canSendWithProvider, providerReadiness, type ProviderReadiness } from './provider-readiness'
import {
  STARK_EFFORT_LABELS,
  STARK_EFFORT_TOOLTIPS,
  STARK_EFFORTS,
  type AgentTarget,
  type StarkEffort
} from '../../../../shared/agent-target/types'
import {
  agentTargetLabel,
  canSelectProvider,
  DEFAULT_AGENT_TARGET,
  DEFAULT_STARK_EFFORT,
  effortVisibleFor,
  findProvider,
  isTargetSwitchBlocked,
  resolveComposerSend
} from './agent-target-state'
import { listExtensionAgentProviders, runExtensionAgent } from '../../lib/extension-agents-api'
import type { UsageSummary } from '../../../../shared/usage/types'
import { initialProviderPanelState, providerPanelReducer } from './provider-state'
import { initialSessionPanelState, sessionPanelReducer } from './session-state'
import type { SessionContextDraftAction } from './session-context-state'
import {
  initialProposalState,
  proposalEligibility,
  proposalReducer
} from './proposal-state'
import { initialWorkPanelState, workPanelReducer } from './work-state'
import {
  BRAIN_GENERIC_MESSAGE,
  normalizeBrainError
} from '../../lib/brain-error'
import { getHeartConfig, saveHeartConfig } from '../../lib/heart-api'
import { initialHeartPanelState, heartPanelReducer } from './heart-state'
import { initialModelChainsPanelState, modelChainsPanelReducer } from '../settings/sections/models/model-chains-state'
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
import { attachmentAiState } from './attachment-ai-inclusion'
import { VoiceInputButton } from './VoiceInputButton'
import { appendTranscription } from './voice-recorder'
import {
  closeSessionTab,
  discardSessionDraft,
  emptySessionTabDraft,
  isSessionTabDirty,
  MAX_OPEN_SESSION_TABS,
  openSessionTab,
  stashSessionDraft,
  TAB_LIMIT_NOTICE,
  type SessionTabDraft
} from './session-tabs'
import { productionEntitlements, toSponsorEntitlement } from '../billing/entitlements'
import { useBrandAssets } from '../styles/use-brand-assets'
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
  /** Opens the shell settings surface (e.g. no-provider guidance → Models). Optional for tests. */
  readonly onOpenSettings?: (section: SettingsSection) => void
  /** Workarea portal target for the full-page Settings surface (owned by the shell). */
  readonly settingsHost: HTMLDivElement | null
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
  /** Renderer-local open tabs (presentation only, order = strip order). */
  readonly openSessionIds: readonly number[]
  readonly sessionsLoading: boolean
  readonly looplinkActing: boolean
  readonly sendBusy: boolean
  /** A creation is in flight: the shell disables + (one creation at a time). */
  readonly creatingSession: boolean
  /** Composer agent target (STARK default; extension rows are discovered data). */
  readonly agentTarget: AgentTarget
  /** STARK effort selector (applies to STARK runs only). */
  readonly effort: StarkEffort
  /** Display label for the target (STARK or the provider's own name). */
  readonly agentLabel: string
  /** Provider truth for Usage Status (canonical readiness — banner and sidebar share this). */
  readonly providerStatus: ProviderReadiness
  /** Actual current model id, or null when none is selected. */
  readonly providerModel: string | null
  /** Created-at of the selected session, or null when none is selected. */
  readonly selectedSessionCreatedAt: number | null
  /** Product plan label for Usage Status (e.g. "STARK Free"). */
  readonly planLabel: string
  /** Real local 24h usage summary, or null while unloaded. */
  readonly usageSummary: UsageSummary | null
  /** Known managed-runtime preview URL for Live Review, or null. */
  readonly runtimePreviewUrl: string | null
}

/** Existing session actions forwarded to the shell unchanged. */
export interface SessionChromeActions {
  readonly newSession: () => void
  readonly selectSession: (sessionId: number) => void
  readonly continueLooplink: () => void
  /**
   * Closes the visible session tab (presentation only — never deletes
   * persisted history, messages, or committed attachments). Guards
   * unsent drafts with confirmation; see handleCloseRequest.
   */
  readonly closeSession: () => void
  /**
   * Closes one open tab by id (inactive tabs included). Same
   * presentation-only semantics with the same draft guard.
   */
  readonly closeSessionTab: (sessionId: number) => void
}

const OPENAI_PROVIDER_ID = 'openai' as const

/**
 * Sponsored-working production binding (Free-tier monetization foundation).
 * Production uses the null provider → renders nothing until a real sponsor
 * provider is integrated. The dev/test fixture is injected explicitly in
 * tests only and never referenced here. Billing source is future work:
 * entitlement defaults to Free via the narrow policy seam.
 */
const SPONSOR_PROVIDER = new NullSponsorProvider()

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

/** Content URL for one stored attachment (opaque ID only, main-resolved). */
function attachmentContentUrl(id: string): string {
  return `stark-attachment://${id}`
}

/** Human-readable byte size for attachment cards (display only). */
function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) {
    const rounded = Math.round(kilobytes * 10) / 10
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)} KB`
  }
  const megabytes = kilobytes / 1024
  const rounded = Math.round(megabytes * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)} MB`
}

/** Short type label derived from the stored MIME type (display only). */
function attachmentTypeLabel(attachment: ChatAttachment): string {
  if (attachment.kind === 'image') {
    return 'Image'
  }
  const slash = attachment.mimeType.indexOf('/')
  const subtype = slash === -1 ? attachment.mimeType : attachment.mimeType.slice(slash + 1)
  if (subtype === '' || subtype === 'octet-stream') {
    return 'File'
  }
  return subtype.toUpperCase()
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
  onOpenSettings,
  settingsHost,
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
  // Settings → Models V2 Brain/Heart LoopLink chain configuration:
  // renderer/session-local ordered stable model ids, workspace-scoped
  // like every other panel state. No persistence (schema stays v19),
  // no IPC, no secrets — configuration for the later AI pass only.
  const [modelChains, modelChainsDispatch] = useReducer(modelChainsPanelReducer, workspaceId, (id) => ({
    ...initialModelChainsPanelState(),
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
  // Local file/image attachments staged for the next send. Draft-only:
  // the panel remounts per workspace, committed rows persist server-side.
  const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([])
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  // Session-creation guard (one creation at a time, no polling, no
  // retry loop): the ref rejects re-entry synchronously across rapid
  // + clicks; the state mirrors to the shell so + disables visibly.
  const creatingRef = useRef(false)
  const [creatingSession, setCreatingSession] = useState(false)
  // Close-tab confirmation: set while the user decides about an unsent
  // draft. Committed attachments are never touched by the close path.
  const [confirmingClose, setConfirmingClose] = useState(false)
  // Pending close target: the tab id awaiting confirmation (active or
  // inactive). performClose reads it so inactive tabs close without
  // disturbing the live selection, composer, or attachments.
  const closeTabIdRef = useRef<number | null>(null)
  // Open session tabs (renderer-local presentation, bounded, order =
  // strip order) plus per-session unsent drafts. The panel remounts per
  // workspace, so both reset on project switch; restart reopens the
  // last active session as a single tab through the normal selection.
  const [openSessionIds, setOpenSessionIds] = useState<readonly number[]>([])
  const [tabDrafts, setTabDrafts] = useState<Readonly<Record<number, SessionTabDraft>>>({})
  // Calm tab-cap notice (status, never an exception): set when + or
  // history is blocked at MAX_OPEN_SESSION_TABS, cleared on the next
  // successful open/select/close. Never tied to drafts or attachments.
  const [tabLimitNotice, setTabLimitNotice] = useState<string | null>(null)
  // Previous selection for draft stash/restore (updated by the sync
  // effect below, never rendered).
  const prevSelectedRef = useRef<number | null>(null)
  // Latest selected session for async ownership checks: completions
  // must land in the session that started them, never in whichever tab
  // happens to be active when the promise resolves. Updated by the
  // same sync effect, read by every guarded async completion below.
  const selectedSessionIdRef = useRef<number | null>(null)
  // Request guards against last-writer-wins races (approval, recovery):
  // a stale in-flight load for a previous tab must not overwrite the
  // current tab's card or banner when it resolves late.
  const approvalRequestRef = useRef(0)
  const recoveryRequestRef = useRef(0)
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
  // Composer agent target + STARK effort (presentation only, per
  // session inside the existing tab-draft stash — renderer memory
  // only, never web storage, never the DB, so schema stays v19 with
  // no migration; the panel remounts per workspace so nothing leaks
  // across projects). Target switches never touch the draft: the
  // composer text and staged attachments survive unchanged, and a
  // switch during an active run is blocked with calm copy.
  const [agentTarget, setAgentTarget] = useState<AgentTarget>(() => ({ ...DEFAULT_AGENT_TARGET }))
  const [effort, setEffort] = useState<StarkEffort>(() => DEFAULT_STARK_EFFORT)
  // Discovered extension agent providers (dynamic menu source — no
  // hardcoded vendors). Loaded explicitly per workspace through the
  // narrow list channel; no polling, no timers.
  const [providers, setProviders] = useState<readonly ExtensionAgentProviderInfo[]>([])
  const [providersError, setProvidersError] = useState<string | null>(null)
  // One extension-agent run at a time (mirrors the STARK guards).
  const [extensionRunning, setExtensionRunning] = useState(false)
  const extensionRequestRef = useRef(0)
  // Latest extension-run proposals awaiting human Review (per session).
  const [extensionOutcome, setExtensionOutcome] = useState<{
    readonly sessionId: number
    readonly transactionIds: readonly number[]
  } | null>(null)
  const [targetMenuOpen, setTargetMenuOpen] = useState(false)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [targetBlockedNotice, setTargetBlockedNotice] = useState<string | null>(null)
  const targetButtonRef = useRef<HTMLButtonElement | null>(null)
  const targetMenuRef = useRef<HTMLDivElement | null>(null)
  const effortButtonRef = useRef<HTMLButtonElement | null>(null)
  const effortMenuRef = useRef<HTMLDivElement | null>(null)

  /** Composer textarea auto-grow: 52px floor, 240px cap, then scroll. */
  useEffect(() => {
    const element = composerRef.current
    if (element === null) {
      return
    }
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [composer])

  // Target/effort menu dismissal: Escape closes (focus back on the
  // trigger), outside pointer-down closes. Listeners live only while
  // a menu is open.
  useEffect(() => {
    if (!targetMenuOpen && !effortMenuOpen) {
      return
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        const returnToEffort = effortMenuOpen
        setTargetMenuOpen(false)
        setEffortMenuOpen(false)
        if (returnToEffort) {
          effortButtonRef.current?.focus()
        } else {
          targetButtonRef.current?.focus()
        }
      }
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (
        targetMenuRef.current?.contains(target) === true ||
        targetButtonRef.current?.contains(target) === true ||
        effortMenuRef.current?.contains(target) === true ||
        effortButtonRef.current?.contains(target) === true
      ) {
        return
      }
      setTargetMenuOpen(false)
      setEffortMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [targetMenuOpen, effortMenuOpen])

  // Canonical provider readiness: the session banner AND the Usage
  // sidebar render from this one value, so "not connected" and
  // "configured" can never contradict each other.
  const readiness = providerReadiness(provider.configured, provider.selectedModel)
  const aiReady = canSendWithProvider(readiness)

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

  // Usage live updates: when an AI call settles, reload the local
  // summary so the Usage sidebar reflects the just-finished call
  // without reopening anything. Existing state/subscription only —
  // no polling.
  const wasSendingRef = useRef(false)
  useEffect(() => {
    if (wasSendingRef.current && !state.sending) {
      void refreshUsageSummary(workspaceId)
    }
    wasSendingRef.current = state.sending
  }, [workspaceId, state.sending])

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
    modelChainsDispatch({ type: 'workspace-changed', workspaceId })
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
    // Real provider discovery: explicit single list per workspace
    // through the narrow agent channel. The menu renders whatever is
    // registered — STARK plus discovered providers, never a fixed
    // vendor list. No polling, no timers. State settles only in the
    // async callbacks below (never synchronously in the effect).
    void listExtensionAgentProviders().then(
      (found) => {
        setProviders(found)
        setProvidersError(null)
      },
      (error: unknown) => {
        setProviders([])
        setProvidersError(
          error instanceof Error && error.message !== '' ? error.message : 'We couldn’t list compatible agent extensions.'
        )
      }
    )
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
    // Stale extension outcomes never render for other sessions (the
    // Review offer checks its session id); returning to the session
    // restores its still-pending offer. Cleared on the next send.
    void loadSessionLooplink(selectedSessionId)
    void loadRecoveryForSelected(selectedSessionId)
    void loadPendingApproval(selectedSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, selectedSessionId])

  // Open-tab sync (declared after the session-changed effect so the
  // mode restore below wins over the proposal reset above). Every
  // selection — tab click, history open, +, recovery handoff — lands
  // here exactly once per selection identity:
  // (a) the previous tab's live draft is stashed (switching never
  //     discards unsent text, staged attachments, or the mode);
  // (b) the new selection is ensured an open tab when below the cap —
  //     at the cap the strip is left unchanged with the calm limit
  //     notice (never evict, never release draft assets);
  // (c) the new tab's stash is restored into the live composer (fresh
  //     tabs start empty). Only the active session renders; stashes
  //     are metadata, never mounted trees.
  useEffect(() => {
    const prev = prevSelectedRef.current
    prevSelectedRef.current = selectedSessionId
    selectedSessionIdRef.current = selectedSessionId
    if (selectedSessionId === null) {
      return
    }
    if (prev !== null && prev !== selectedSessionId && openSessionIds.includes(prev)) {
      // The previous tab's live draft is stashed (switching never
      // discards unsent text, staged attachments, target, or effort).
      const stashed: SessionTabDraft = { composer, attachments, mode: proposal.mode, target: agentTarget, effort }
      setTabDrafts((drafts) => stashSessionDraft(drafts, prev, stashed))
    }
    if (!openSessionIds.includes(selectedSessionId)) {
      const next = openSessionTab(openSessionIds, selectedSessionId, prev)
      if (next.result === 'limit_reached') {
        // Defensive net only: handleSelect (+ already-guarded history)
        // and handleNew (already-guarded +) reject at-cap opens before
        // dispatching, so this fires solely for system-driven
        // selections. Leave every tab, draft, and attachment untouched.
        setTabLimitNotice(TAB_LIMIT_NOTICE)
      } else {
        setOpenSessionIds(next.openIds)
        setTabLimitNotice(null)
      }
    }
    if (prev === null || prev === selectedSessionId) {
      return
    }
    const incoming = tabDrafts[selectedSessionId] ?? emptySessionTabDraft(proposal.mode)
    setComposer(incoming.composer)
    setAttachments(incoming.attachments)
    // Per-session target + effort restore (absent means the
    // STARK/Regular defaults for fresh tabs).
    setAgentTarget(incoming.target ?? { kind: 'stark' })
    setEffort(incoming.effort ?? DEFAULT_STARK_EFFORT)
    if (incoming.mode !== proposal.mode) {
      proposalDispatch({ type: 'mode-changed', workspaceId, mode: incoming.mode })
    }
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
      const outcome = await generateAssistantResponseRaw({ workspaceId, sessionId, effort })
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
    // Single-flight creation through the EXISTING session system
    // (createCodingSession → session-created → chrome mirror): works
    // with no AI provider connected, switches to the new session with
    // an empty conversation, and never duplicates on rapid clicks.
    // The live draft is NOT cleared here: the selection effect stashes
    // it under the previous session and restores an empty draft for
    // the fresh tab, so + never discards unsent work.
    // Tab-cap guard BEFORE any backend work: at 12 open tabs no
    // database session is created, selection and drafts are untouched,
    // and the calm limit notice is shown instead.
    if (state.loadingSessions || creatingRef.current) {
      return
    }
    if (openSessionIds.length >= MAX_OPEN_SESSION_TABS) {
      setTabLimitNotice(TAB_LIMIT_NOTICE)
      return
    }
    creatingRef.current = true
    setCreatingSession(true)
    try {
      const session = await createCodingSession(workspaceId)
      setTabLimitNotice(null)
      dispatch({ type: 'session-created', session })
      composerRef.current?.focus()
    } catch (error: unknown) {
      dispatch({
        type: 'sessions-failed',
        workspaceId,
        requestId: state.sessionsRequestId,
        message: toErrorMessage(error, SESSION_LIST_MESSAGE)
      })
    } finally {
      creatingRef.current = false
      setCreatingSession(false)
    }
  }

  function handleSelect(sessionId: number): void {
    if (sessionId === state.selectedSessionId) {
      return
    }
    // History behavior at the cap: already-open tabs always activate
    // (even at 12); unopened entries are rejected with the calm notice
    // and the active session, tabs, and drafts stay exactly as they
    // were. Never creates a duplicate tab or a backend session here.
    if (!openSessionIds.includes(sessionId) && openSessionIds.length >= MAX_OPEN_SESSION_TABS) {
      setTabLimitNotice(TAB_LIMIT_NOTICE)
      return
    }
    setTabLimitNotice(null)
    dispatch({ type: 'session-selected', workspaceId, sessionId })
  }

  /**
   * Closes the visible session tab. CLOSE ≠ DELETE: persisted history,
   * database messages, and committed attachments are never touched —
   * only the tab/workspace presentation changes. Closing the active
   * tab selects the tab to the left (else the first remaining tab),
   * or creates a fresh local New session when none remains. An
   * unsent draft (composer text or staged draft attachments) requires
   * explicit confirmation first; confirming releases uncommitted
   * draft assets through the existing narrow removeDraft API
   * (bounded: at most 10).
   */
  function handleCloseRequest(): void {
    requestCloseTab(state.selectedSessionId)
  }

  /** Live composer draft snapshot for stash/close decisions. */
  function liveDraft(): SessionTabDraft {
    return { composer, attachments, mode: proposal.mode, target: agentTarget, effort }
  }

  /**
   * Guarded close for any open tab (active or inactive). Inactive
   * tabs guard on their stashed draft, so the live selection,
   * composer, and attachments are never disturbed by the check.
   */
  function requestCloseTab(sessionId: number | null): void {
    if (sessionId === null || creatingRef.current) {
      return
    }
    const draft =
      sessionId === state.selectedSessionId
        ? liveDraft()
        : (tabDrafts[sessionId] ?? emptySessionTabDraft(proposal.mode))
    closeTabIdRef.current = sessionId
    if (!isSessionTabDirty(draft)) {
      void performClose()
      return
    }
    setConfirmingClose(true)
  }

  function handleCloseCancel(): void {
    closeTabIdRef.current = null
    setConfirmingClose(false)
  }

  async function performClose(): Promise<void> {
    const closingId = closeTabIdRef.current ?? state.selectedSessionId
    if (closingId === null || creatingRef.current) {
      return
    }
    closeTabIdRef.current = null
    setConfirmingClose(false)
    const isActive = closingId === state.selectedSessionId
    const draft = isActive ? liveDraft() : (tabDrafts[closingId] ?? emptySessionTabDraft(proposal.mode))
    // Release uncommitted draft assets only (best effort, bounded);
    // committed attachments live server-side and are never removed.
    if (draft.attachments.length > 0) {
      if (isActive) {
        setAttachments([])
      }
      await Promise.allSettled(draft.attachments.map((entry) => removeChatAttachmentDraft(entry.id)))
    }
    setTabDrafts((drafts) => discardSessionDraft(drafts, closingId))
    const { openIds, nextActiveId } = closeSessionTab(openSessionIds, closingId, state.selectedSessionId)
    setOpenSessionIds(openIds)
    // A freed slot clears a stale cap notice so + can proceed calmly.
    setTabLimitNotice(null)
    if (!isActive) {
      return
    }
    if (nextActiveId !== null) {
      dispatch({ type: 'session-selected', workspaceId, sessionId: nextActiveId })
      return
    }
    // No remaining session in this workspace: open a fresh local New
    // session through the same guarded single-flight creation. The
    // closed session stays in persisted history (history is preserved).
    await handleNew()
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
    if (state.selectedSessionId === null || state.sending || extensionRunning) {
      return
    }
    const sessionId = state.selectedSessionId
    const content = composer
    if ((isComposerEmpty(content) && attachments.length === 0) || composerByteLength(content) > COMPOSER_MAX_BYTES) {
      return
    }
    // A new send supersedes any previous extension proposal offer.
    setExtensionOutcome(null)
    // Data-driven target resolution: STARK sends use the unified Work
    // path (slash overrides win); extension sends run one bounded
    // provider turn with the raw text. Unavailable providers fail
    // closed with their honest reason — never fake output.
    const resolved = resolveComposerSend(agentTarget, content, providers)
    if (resolved.kind === 'extension') {
      await handleExtensionSend(sessionId, content, resolved.extensionId, resolved.providerId)
      return
    }
    if (resolved.kind === 'blocked') {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: resolved.reason
      })
      return
    }
    // Unified STARK send: the Work path handles both questions and
    // coding tasks (Brain answers directly when no tools are needed).
    // /ask, /work, /propose are explicit internal overrides reusing
    // the preserved runtime paths — no classifier, no new model.
    const sendContent = resolved.content
    if (resolved.mode !== proposal.mode) {
      proposalDispatch({ type: 'mode-changed', workspaceId, mode: resolved.mode })
      if (resolved.mode === 'work') {
        void loadLatestWorkRun(sessionId)
      }
    }
    // Ownership snapshot: the clear step must remove exactly these
    // attachments from the session that sent them, even if the user
    // switched tabs while the send was in flight.
    const sentAttachmentIds = attachments.map((entry) => entry.id)
    if (resolved.mode === 'propose') {
      await handleProposeSend(sessionId, sendContent)
      return
    }
    if (resolved.mode === 'work') {
      await handleWorkSend(sessionId, sendContent)
      return
    }
    const generateAfterSend = aiReady
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      // The persisted message carries the slash-stripped content; the
      // composer clear below still matches the full typed text so no
      // keystrokes are ever stranded.
      const result = await sendSessionUserMessage(messageSendPayload(sessionId, sendContent))
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      // Clear only the sent text: keystrokes typed during the send are
      // newer composer state and must be preserved. The reducer drops
      // the result entirely if the selection moved on meanwhile.
      clearSentComposer(content, sessionId, sentAttachmentIds)
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
   * Extension-agent send: persists the user message + reviewed context
   * through the normal Stage 15 path, then runs one bounded provider
   * turn for the persisted trailing message. Provider text lands in
   * the same conversation; structured file edits become pending
   * Change Transactions for human Review (never direct writes).
   * STARK effort is never sent — extensions own their behavior.
   * Single-flight with STARK generation through the shared
   * generate-started/succeeded/failed actions; outcomes land only in
   * the originating session.
   */
  async function handleExtensionSend(
    sessionId: number,
    content: string,
    extensionId: string,
    providerId: string
  ): Promise<void> {
    if (extensionRunning || state.generating) {
      return
    }
    const sentAttachmentIds = attachments.map((entry) => entry.id)
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(messageSendPayload(sessionId, content))
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      clearSentComposer(content, sessionId, sentAttachmentIds)
    } catch (error: unknown) {
      dispatch({
        type: 'send-failed',
        workspaceId,
        sessionId,
        message: toSendErrorMessage(error)
      })
      return
    }
    const requestId = extensionRequestRef.current + 1
    extensionRequestRef.current = requestId
    setExtensionRunning(true)
    dispatch({ type: 'generate-started', workspaceId, sessionId, requestId })
    try {
      const outcome = await runExtensionAgent({ workspaceId, sessionId, extensionId, providerId })
      // Ownership: the outcome belongs to the session that started it.
      if (extensionRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
      stickToBottomRef.current = true
      dispatch({
        type: 'generate-succeeded',
        workspaceId,
        sessionId,
        requestId,
        session: outcome.session,
        message: outcome.message
      })
      if (outcome.proposalTransactionIds.length > 0) {
        setExtensionOutcome({ sessionId, transactionIds: outcome.proposalTransactionIds })
      }
    } catch (error: unknown) {
      if (extensionRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
      dispatch({
        type: 'generate-failed',
        workspaceId,
        sessionId,
        requestId,
        message: error instanceof Error && error.message !== '' ? error.message : 'We couldn’t run that extension agent.'
      })
    } finally {
      setExtensionRunning(false)
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
    const sentAttachmentIds = attachments.map((entry) => entry.id)
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(messageSendPayload(sessionId, content))
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      clearSentComposer(content, sessionId, sentAttachmentIds)
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
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId, effort })
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
      const outcome = await proposeAiFileChange({ workspaceId, sessionId, effort })
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
        const outcome = await proposeAiChangeSet({ workspaceId, sessionId, effort })
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
      const outcome = await proposeAiFileChange({ workspaceId, sessionId, effort })
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

  /**
   * Agent-target selection: STARK is always selectable; extension
   * rows are selectable only when their provider reports available.
   * No vendor branches — identity is data (extensionId/providerId).
   * A switch during an active run is blocked with calm copy — the
   * draft (composer text + staged attachments) always survives.
   */
  function selectAgentTarget(next: AgentTarget): void {
    setTargetMenuOpen(false)
    if (next.kind === 'extension') {
      const row = findProvider(providers, next.extensionId, next.providerId)
      if (row === undefined || !canSelectProvider(row)) {
        composerRef.current?.focus()
        return
      }
    }
    if (
      isTargetSwitchBlocked({
        sending: state.sending,
        generating: state.generating,
        proposalPreparing: proposal.preparing,
        workPreparing: work.preparing,
        agentRunning: extensionRunning
      })
    ) {
      setTargetBlockedNotice('Finish the current run before switching agents.')
      composerRef.current?.focus()
      return
    }
    setTargetBlockedNotice(null)
    setAgentTarget(next)
    composerRef.current?.focus()
  }

  /** STARK effort selection (STARK target only; hidden otherwise). */
  function selectEffort(next: StarkEffort): void {
    setEffortMenuOpen(false)
    setEffort(next)
    composerRef.current?.focus()
  }

  /** Arrow-key navigation between menu items (Tab/Enter stay native). */
  function handleTargetEffortMenuKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    menu: HTMLDivElement | null
  ): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }
    if (menu === null) {
      return
    }
    event.preventDefault()
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]'))
    if (items.length === 0) {
      return
    }
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null
    const at = active === null ? -1 : items.indexOf(active)
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }

  /** Empty composer body click focuses the textarea (controls keep focus). */
  function handleComposerBodyClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) {
      return
    }
    if (target.closest('button, textarea, a, input, [role="menu"], img') !== null) {
      return
    }
    composerRef.current?.focus()
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
    const requestId = approvalRequestRef.current + 1
    approvalRequestRef.current = requestId
    try {
      const found = await getPendingWorkerApproval({ workspaceId, sessionId })
      // Ownership: a load started by tab A must not overwrite tab B's
      // card when A resolves after the user switched tabs.
      if (approvalRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
      setPendingApproval(found)
      setApprovalError(null)
    } catch (error: unknown) {
      if (approvalRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
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
      // The decision belonged to the originating tab; its failure must
      // not surface on another tab the user switched to meanwhile.
      if (selectedSessionIdRef.current === sessionId) {
        setApprovalError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t resolve this approval.')
      }
    } finally {
      setApprovalActing(false)
    }
  }

  async function handleToolResumeOutcome(outcome: import('../../../../shared/ai/types').WorkRecoveryResult, sessionId: number): Promise<void> {
    if (!('kind' in outcome)) {
      return
    }
    // Approval cards stay attached to the originating session: run and
    // message updates are session-scoped by the reducers, but the
    // card itself must not leak into another tab's view.
    const stillCurrent = selectedSessionIdRef.current === sessionId
    if (outcome.kind === 'completed') {
      if (stillCurrent) {
        setPendingApproval(null)
      }
      stickToBottomRef.current = true
      workDispatch({ type: 'run-succeeded', workspaceId, sessionId, run: outcome.result.run })
      dispatch({ type: 'work-completed', workspaceId, session: outcome.result.session, message: outcome.result.message })
      void loadSessionLooplink(sessionId)
      void loadLatestWorkRun(sessionId)
      return
    }
    if (outcome.kind === 'waiting_for_approval') {
      if (stillCurrent) {
        setPendingApproval(outcome.approval)
      }
      void loadLatestWorkRun(sessionId)
      return
    }
    // Recovery handoffs from a pre-tool failure surface as safe copy.
    if (stillCurrent) {
      setPendingApproval(null)
    }
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
    const requestId = recoveryRequestRef.current + 1
    recoveryRequestRef.current = requestId
    try {
      const found = await getRecoveryForTarget({ workspaceId, sessionId })
      // Ownership: the banner belongs to the session that requested it.
      if (recoveryRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: found })
    } catch (error: unknown) {
      if (recoveryRequestRef.current !== requestId || selectedSessionIdRef.current !== sessionId) {
        return
      }
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
      if (selectedSessionIdRef.current !== sessionId) {
        return
      }
      recoveryDispatch({ type: 'event-loaded', workspaceId, event: dismissed })
      void loadSessionLooplink(sessionId)
    } catch {
      if (selectedSessionIdRef.current !== sessionId) {
        return
      }
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
    const sentAttachmentIds = attachments.map((entry) => entry.id)
    dispatch({ type: 'send-started', workspaceId, sessionId })
    try {
      const result = await sendSessionUserMessage(messageSendPayload(sessionId, content))
      stickToBottomRef.current = true
      dispatch({ type: 'send-succeeded', workspaceId, session: result.session, message: result.message })
      clearSentComposer(content, sessionId, sentAttachmentIds)
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
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId, effort })
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
      const outcome = await runBrainWorkRaw({ workspaceId, sessionId, effort })
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

  /** Builds the send payload with context drafts plus staged attachment IDs. */
  function messageSendPayload(
    sessionId: number,
    content: string
  ): { workspaceId: number; sessionId: number; content: string; context?: readonly SessionContextDraft[]; attachments?: readonly string[] } {
    const attached = [...contextDrafts]
    const attachmentIds = attachments.map((entry) => entry.id)
    return {
      workspaceId,
      sessionId,
      content,
      ...(attached.length > 0 ? { context: attached } : {}),
      ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {})
    }
  }

  /** Clears exactly what a send consumed, in the session that sent it. */
  function clearSentComposer(content: string, originSessionId: number, sentAttachmentIds: readonly string[]): void {
    if (selectedSessionIdRef.current !== originSessionId) {
      // The user switched tabs mid-send: the origin tab stashed the
      // sent text and attachments when it was left, so clear exactly
      // those from its stash. The newly active tab stays untouched.
      setTabDrafts((drafts) => {
        const prev = drafts[originSessionId]
        if (prev === undefined) {
          return drafts
        }
        return stashSessionDraft(drafts, originSessionId, {
          ...prev,
          composer: prev.composer === content ? '' : prev.composer,
          attachments: prev.attachments.filter((entry) => !sentAttachmentIds.includes(entry.id))
        })
      })
      return
    }
    setComposer((current) => (current === content ? '' : current))
    // Filter (not wipe): only the consumed attachment IDs leave, so a
    // draft staged alongside the send is never discarded with it.
    setAttachments((current) => current.filter((entry) => !sentAttachmentIds.includes(entry.id)))
    contextDraftsDispatch({ type: 'drafts-cleared', workspaceId })
    composerRef.current?.focus()
  }

  async function handleAttach(): Promise<void> {
    if (state.sending || attachBusy || proposal.preparing || work.preparing) {
      return
    }
    const originSessionId = state.selectedSessionId
    setAttachBusy(true)
    setAttachError(null)
    try {
      const picked = await chooseChatAttachments(workspaceId)
      if (picked.length === 0) {
        return
      }
      if (originSessionId !== null && selectedSessionIdRef.current === originSessionId) {
        setAttachments((current) => [...current, ...picked])
        composerRef.current?.focus()
        return
      }
      // The picker resolved after a tab switch: the files stay owned
      // by the originating session's stashed draft, never the newly
      // active tab. (Null origin means no owning session; drop calmly.)
      if (originSessionId !== null) {
        setTabDrafts((drafts) => {
          const prev = drafts[originSessionId] ?? emptySessionTabDraft(proposal.mode)
          return stashSessionDraft(drafts, originSessionId, {
            ...prev,
            attachments: [...prev.attachments, ...picked]
          })
        })
      }
    } catch (error: unknown) {
      setAttachError(error instanceof Error && error.message !== '' ? error.message : 'We couldn’t attach those files.')
    } finally {
      setAttachBusy(false)
    }
  }

  /**
   * Inserts successful voice transcription into the composer. Existing
   * text is preserved (appended with spacing); nothing auto-sends —
   * the user edits and sends normally.
   */
  function handleVoiceTranscribed(text: string): void {
    const clean = text.trim()
    if (clean === '') {
      return
    }
    setComposer((current) => appendTranscription(current, clean, null).text)
    composerRef.current?.focus()
  }

  function handleRemoveAttachment(attachmentId: string): void {    setAttachments((current) => current.filter((entry) => entry.id !== attachmentId))
    // Best effort: the backing draft asset is removed main-side when
    // unreferenced; a failure leaves a recoverable orphan, never a
    // broken message (links persist only on successful send).
    void removeChatAttachmentDraft(attachmentId).catch(() => {})
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
          isEmpty: isComposerEmpty(composer) && attachments.length === 0,
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
  const empty = isComposerEmpty(composer) && attachments.length === 0
  const overLimit = composerByteLength(composer) > COMPOSER_MAX_BYTES
  const eligibility = proposalEligibility(contextDrafts)
  // Live send resolution for gating: a STARK `/propose` draft without
  // eligible whole-file context disables send with guidance copy.
  // Extension targets never gate on STARK proposal eligibility.
  const resolvedComposerSend = resolveComposerSend(agentTarget, composer, providers)
  const proposeGated =
    resolvedComposerSend.kind === 'stark' && resolvedComposerSend.mode === 'propose' && !eligibility.eligible
  // loadingMessages gates sending: a latest page in flight must settle
  // first, otherwise its replace-on-arrive could drop a just-appended
  // message. Older-page loads only prepend, so they never clobber.
  const sendDisabled =
    state.selectedSessionId === null ||
    empty ||
    state.sending ||
    overLimit ||
    state.loadingMessages ||
    proposal.preparing ||
    work.preparing ||
    extensionRunning ||
    proposeGated
  // Sponsored-working narrow binding: observational AI-run state only.
  // Never delays, gates, or alters sends, generations, proposals, work
  // runs, streaming, cancellation, navigation, Settings, or terminal.
  const sponsorAiState = deriveAiRunState({
    sending: state.sending,
    generating: state.generating,
    proposalPreparing: proposal.preparing,
    workPreparing: work.preparing,
    looplinkActing: looplink.acting
  })
  const sponsorRunId = useMemo(
    () =>
      buildAiRunId({
        workspaceId,
        sessionId: state.selectedSessionId,
        generationRequestId: state.generationRequestId
      }),
    [workspaceId, state.selectedSessionId, state.generationRequestId]
  )
  // Central product entitlements drive the sponsor gate and the
  // LoopLink caps (Free today; paid/funded states arrive with the
  // billing backend). Sponsor lifecycle/viewability/privacy logic is
  // untouched.
  const sponsorProductEntitlements = useMemo(() => productionEntitlements(), [])
  const sponsorEntitlement = useMemo(() => toSponsorEntitlement(sponsorProductEntitlements), [sponsorProductEntitlements])
  // Style-aware empty-session watermark (Settings → Styles). Same
  // opacity/layout — only the asset family changes.
  const { wordmarkUrl: brandWordmarkUrl } = useBrandAssets()
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
  // Empty-conversation watermark: the official wordmark shows only
  // while the ACTIVE session truly has no conversation content yet.
  // Draft text alone never hides it; any message, send, generation,
  // proposal, work run, continuity, recovery, approval, or runtime
  // content does.
  const conversationEmpty =
    state.messages.length === 0 &&
    !state.loadingMessages &&
    state.messagesError === null &&
    !state.sending &&
    !state.generating &&
    state.generationError === null &&
    !proposal.preparing &&
    proposal.error === null &&
    proposal.result === null &&
    proposal.changeSet === null &&
    !work.preparing &&
    work.error === null &&
    work.run === null &&
    looplink.looplink === null &&
    recovery.event === null &&
    pendingApproval === null &&
    runtime.active === null &&
    runtime.history.length === 0

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
        openSessionIds,
        sessionsLoading: state.loadingSessions,
        looplinkActing: looplink.acting,
        sendBusy: state.sending,
        creatingSession,
        agentTarget,
        effort,
        agentLabel: agentTargetLabel(agentTarget, providers),
        providerStatus: readiness,
        providerModel: provider.selectedModel,
        selectedSessionCreatedAt: selectedSession?.createdAt ?? null,
        planLabel: sponsorProductEntitlements.planLabel,
        usageSummary: usage.summary,
        runtimePreviewUrl: runtime.active?.previewUrl ?? null
      },
      {
        newSession: () => void handleNew(),
        selectSession: (sessionId: number) => handleSelect(sessionId),
        continueLooplink: () => void handleContinueWithLooplink(),
        closeSession: () => handleCloseRequest(),
        closeSessionTab: (sessionId: number) => requestCloseTab(sessionId)
      }
    )
  }, [
    onSessionChrome,
    selectedSession?.title,
    state.sessions,
    state.selectedSessionId,
    openSessionIds,
    state.loadingSessions,
    state.sending,
    creatingSession,
    composer,
    attachments,
    looplink.acting,
    agentTarget,
    effort,
    providers,
    provider.configured,
    provider.selectedModel,
    readiness,
    selectedSession?.createdAt,
    sponsorProductEntitlements.planLabel,
    usage.summary,
    runtime.active
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
        {aiReady ? (
          `OpenAI · ${provider.selectedModel ?? ''}`
        ) : readiness === 'needs-model' ? (
          <>
            {'AI provider configured — select a model to connect.'}
            {onOpenSettings !== undefined && (
              <>
                {' '}
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onOpenSettings('models')}
                  aria-label="Select AI model"
                >
                  Select model
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {'Local session — AI provider not connected yet.'}
            {onOpenSettings !== undefined && (
              <>
                {' '}
                <button
                  className="explorer__secondary"
                  type="button"
                  onClick={() => onOpenSettings('models')}
                  aria-label="Connect AI provider"
                >
                  Connect AI
                </button>
              </>
            )}
          </>
        )}
      </p>
      {tabLimitNotice !== null && (
        <p className="session__notice session__notice--limit" role="status">
          {tabLimitNotice}
        </p>
      )}
      {confirmingClose && (
        <div className="session__confirm" role="alertdialog" aria-label="Close this session?">
          <p className="session__confirm-title">Close this session?</p>
          <p className="session__confirm-copy">You have an unsent draft.</p>
          <div className="session__confirm-actions">
            <button className="explorer__secondary" type="button" onClick={handleCloseCancel}>
              Cancel
            </button>
            <button className="explorer__primary" type="button" onClick={() => void performClose()}>
              Close
            </button>
          </div>
        </div>
      )}
      {settingsOpen &&
        settingsHost !== null &&
        createPortal(
          <SettingsPage
            section={settingsSection}
            onSectionChange={onSettingsSectionChange}
            onBack={onCloseSettings}
            binding={{
              workspaceId,
              provider,
              apiKeyInput,
              onApiKeyInputChange: setApiKeyInput,
              revealKey,
              onToggleRevealKey: () => setRevealKey((reveal) => !reveal),
              modelValue,
              selectedModelMissing,
              useModelDisabled: modelDraft === null || modelDraft === provider.selectedModel,
              onModelDraftChange: setModelDraft,
              onSaveKey: () => void handleSaveKey(),
              onRemoveKey: () => void handleRemoveKey(),
              onTestConnection: () => void handleTestConnection(),
              onRefreshModels: () => void handleRefreshModels(),
              onUseModel: () => void handleUseModel(),
              brainChain: modelChains.brain,
              heartChain: modelChains.heart,
              maxBrainModels: sponsorProductEntitlements.maxBrainModels,
              maxHeartModels: sponsorProductEntitlements.maxHeartModels,
              planLabel: sponsorProductEntitlements.planLabel,
              onToggleModel: (chain, stableId, enable) =>
                modelChainsDispatch(
                  enable
                    ? {
                        type: 'model-enabled',
                        workspaceId,
                        chain,
                        stableId,
                        maxModels:
                          chain === 'brain'
                            ? sponsorProductEntitlements.maxBrainModels
                            : sponsorProductEntitlements.maxHeartModels
                      }
                    : { type: 'model-disabled', workspaceId, chain, stableId }
                ),
              onSwapModel: (chain, outgoingId, incomingId) =>
                modelChainsDispatch({ type: 'model-swapped', workspaceId, chain, outgoingId, incomingId }),
              onReorderModel: (chain, stableId, toIndex) =>
                modelChainsDispatch({ type: 'model-reordered', workspaceId, chain, stableId, toIndex }),
              capabilities,
              capabilitiesDispatch,
              onSaveCapabilities: () => void handleSaveCapabilities(),
              heart,
              heartDispatch,
              onSaveHeart: () => void handleSaveHeart(),
              recovery,
              recoveryDispatch,
              onSaveRecovery: () => void handleSaveRecovery(),
              usage,
              usageDispatch,
              onRefreshUsageSummary: () => void refreshUsageSummary(workspaceId),
              onSaveUsage: () => void handleSaveUsage()
            }}
          />,
          settingsHost
        )}
      {/* Provider and capability settings live in the full-page SettingsPage (portalled to the workarea). */}
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
            {conversationEmpty && (
              <img
                className="session__watermark"
                src={brandWordmarkUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
              />
            )}
            {conversationEmpty && !aiReady && state.selectedSessionId !== null && (
              <div className="session__empty-ai" role="status" aria-label="Connect an AI provider">
                <p className="session__empty-ai-text">Connect an AI provider to use Ask and Work.</p>
                {onOpenSettings !== undefined && (
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => onOpenSettings('models')}
                    aria-label="Add OpenAI key"
                  >
                    Add OpenAI key
                  </button>
                )}
              </div>
            )}
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
                    {(message.attachments ?? []).length > 0 && (
                      <div className="session__attachments-list" aria-label={`Attachments on message ${message.id}`}>
                        {(message.attachments ?? []).map((attachment) => (
                          <div key={attachment.id} className="session__attachment-card">
                            {attachment.kind === 'image' ? (
                              <div className="session__attachment-imagecard" title={attachment.name}>
                                <img
                                  className="session__attachment-image"
                                  src={attachmentContentUrl(attachment.id)}
                                  alt={attachment.name}
                                  draggable={false}
                                  loading="lazy"
                                />
                                <span className="session__attachment-name">{attachment.name}</span>
                                {attachmentAiState(attachment, provider.selectedModel) !== null && (
                                  <span className="session__attachment-sub">
                                    {attachmentAiState(attachment, provider.selectedModel)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="session__attachment-filecard" title={attachment.name}>
                                <span className="session__attachment-filetype" aria-hidden="true">
                                  {attachmentTypeLabel(attachment)}
                                </span>
                                <span className="session__attachment-meta">
                                  <span className="session__attachment-name">{attachment.name}</span>
                                  <span className="session__attachment-sub">
                                    {attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.size)}
                                  </span>
                                </span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
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
                {agentTarget.kind === 'stark' ? 'STARK is thinking…' : 'Extension agent is working…'}
              </p>
            )}
            {/* Sponsored-working slot: single placement inside the existing
                AI working surface. Observational only — the component
                returns null unless Free + genuinely working + visible +
                focused + creative + frequency cap ok. Disappears
                immediately when the run ends. Never inside messages. */}
            <SponsoredWorkingSlot
              key={sponsorRunId}
              runId={sponsorRunId}
              aiState={sponsorAiState}
              entitlement={sponsorEntitlement}
              provider={SPONSOR_PROVIDER}
            />
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
                  {pendingApproval.toolName === 'attachment_import' && (
                    <p className="session__hint" role="note">
                      Capability: Attachment import
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
                        : pendingApproval.toolName === 'attachment_import'
                          ? 'Approval creates a reviewable asset proposal only. Files will not change until you review and Accept them.'
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
                  {pendingApproval.toolName === 'image_generate' && (
                    <>
                      <p className="session__hint" role="note">
                        Capability: Image generation
                      </p>
                      <p className="session__hint" role="note">
                        Approval generates images using the configured AI provider. May use provider credits/API quota. Images appear as chat attachments; project files change only after your separate review and Accept.
                      </p>
                    </>
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
          <div className={`session__composer session__composer--${proposal.mode}`} onClick={handleComposerBodyClick}>
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
                      <UiIcon name="close" size={12} />
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
            {(attachments.length > 0 || attachError !== null) && (
              <div className="session__attachments" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <span key={attachment.id} className="session__attachment-chip" title={attachment.name}>
                    {attachment.kind === 'image' ? (
                      <img
                        className="session__attachment-thumb"
                        src={attachmentContentUrl(attachment.id)}
                        alt=""
                        draggable={false}
                      />
                    ) : (
                      <span className="session__attachment-file" aria-hidden="true">
                        {attachmentTypeLabel(attachment)}
                      </span>
                    )}
                    <span className="session__chip-label">{attachment.name}</span>
                    <button
                      className="session__chip-remove"
                      type="button"
                      onClick={() => handleRemoveAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                      title={`Remove ${attachment.name}`}
                    >
                      <UiIcon name="close" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError !== null && (
              <p className="session__error" role="alert">
                {attachError}
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
            <textarea
              ref={composerRef}
              className="session__input"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Message STARK…"
              title="Enter to send, Shift+Enter for a new line"
              aria-label="Message composer"
              rows={1}
              disabled={state.sending || proposal.preparing || work.preparing}
            />
            <div className="session__rail">
              <div className="session__rail-group">
                <button
                  className="session__attach session__iconbtn"
                  type="button"
                  onClick={() => void handleAttach()}
                  disabled={state.sending || attachBusy || proposal.preparing || work.preparing}
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <UiIcon name="plus" size={16} />
                </button>
                <div className="session__moderail" role="group" aria-label="Agent target">
                  <button
                    ref={targetButtonRef}
                    className={`session__modepill session__modepill--target session__modepill--${agentTarget.kind === 'stark' ? 'ask' : 'propose'}`}
                    type="button"
                    onClick={() => {
                      setEffortMenuOpen(false)
                      setTargetMenuOpen((open) => !open)
                    }}
                    disabled={proposal.preparing || work.preparing}
                    aria-haspopup="menu"
                    aria-expanded={targetMenuOpen}
                    aria-label="Choose agent target"
                    title="Choose agent target"
                  >
                    <span className="session__modepill-label">
                      {agentTarget.kind === 'stark'
                        ? 'STARK'
                        : (findProvider(providers, agentTarget.extensionId, agentTarget.providerId)?.displayName ??
                          'Extension agent')}
                    </span>
                    <UiIcon name="chevron-down" size={12} />
                  </button>
                  {targetMenuOpen && (
                    <div
                      ref={targetMenuRef}
                      className="session__modemenu"
                      role="menu"
                      aria-label="Choose agent target"
                      onKeyDown={(event) => handleTargetEffortMenuKeyDown(event, targetMenuRef.current)}
                    >
                      <button
                        className={`session__modemenu-item session__modemenu-item--ask${
                          agentTarget.kind === 'stark' ? ' session__modemenu-item--checked' : ''
                        }`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={agentTarget.kind === 'stark'}
                        onClick={() => selectAgentTarget({ kind: 'stark' })}
                      >
                        <span className="session__modemenu-dot" aria-hidden="true" />
                        STARK
                      </button>
                      <span className="session__modemenu-label" aria-hidden="true">
                        EXTENSIONS
                      </span>
                      {providersError !== null && (
                        <p className="session__hint" role="status">
                          {providersError}
                        </p>
                      )}
                      {providers.length === 0 ? (
                        <p className="session__hint" role="status">
                          No compatible agent extensions installed
                        </p>
                      ) : (
                        providers.map((row) => {
                          const selectable = canSelectProvider(row)
                          const checked =
                            agentTarget.kind === 'extension' &&
                            agentTarget.extensionId === row.extensionId &&
                            agentTarget.providerId === row.providerId
                          return (
                            <button
                              key={`${row.extensionId}::${row.providerId}`}
                              className={`session__modemenu-item session__modemenu-item--wrap${
                                checked ? ' session__modemenu-item--checked' : ''
                              }`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={checked}
                              disabled={!selectable}
                              title={row.availability.reason ?? row.displayName}
                              aria-label={
                                selectable
                                  ? `Use ${row.displayName}`
                                  : `${row.displayName} — ${row.availability.reason ?? 'unavailable'}`
                              }
                              onClick={() =>
                                selectAgentTarget({
                                  kind: 'extension',
                                  extensionId: row.extensionId,
                                  providerId: row.providerId
                                })
                              }
                            >
                              {row.iconUrl !== null ? (
                                <img
                                  className="session__modemenu-icon"
                                  src={row.iconUrl}
                                  alt=""
                                  aria-hidden="true"
                                  draggable={false}
                                />
                              ) : (
                                <UiIcon name="extensions" size={14} />
                              )}
                              <span className="session__modemenu-name">{row.displayName}</span>
                              {!selectable && (
                                <span className="session__modemenu-reason">
                                  {row.availability.reason ?? 'unavailable'}
                                </span>
                              )}
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
                {effortVisibleFor(agentTarget) && (
                  <div className="session__moderail" role="group" aria-label="STARK effort">
                    <button
                      ref={effortButtonRef}
                      className="session__modepill session__modepill--effort"
                      type="button"
                      onClick={() => {
                        setTargetMenuOpen(false)
                        setEffortMenuOpen((open) => !open)
                      }}
                      disabled={proposal.preparing || work.preparing}
                      aria-haspopup="menu"
                      aria-expanded={effortMenuOpen}
                      aria-label="Choose STARK effort"
                      title={STARK_EFFORT_TOOLTIPS[effort]}
                    >
                      <span className="session__modepill-label">{STARK_EFFORT_LABELS[effort]}</span>
                      <UiIcon name="chevron-down" size={12} />
                    </button>
                    {effortMenuOpen && (
                      <div
                        ref={effortMenuRef}
                        className="session__modemenu"
                        role="menu"
                        aria-label="Choose STARK effort"
                        onKeyDown={(event) => handleTargetEffortMenuKeyDown(event, effortMenuRef.current)}
                      >
                        {STARK_EFFORTS.map((level) => (
                          <button
                            key={level}
                            className={`session__modemenu-item${
                              effort === level ? ' session__modemenu-item--checked' : ''
                            }`}
                            type="button"
                            role="menuitemradio"
                            aria-checked={effort === level}
                            title={STARK_EFFORT_TOOLTIPS[level]}
                            onClick={() => selectEffort(level)}
                          >
                            <span className="session__modemenu-dot" aria-hidden="true" />
                            {STARK_EFFORT_LABELS[level]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="session__rail-group">
                <VoiceInputButton
                  key={`voice-${String(state.selectedSessionId ?? 'none')}`}
                  disabled={state.sending || attachBusy || proposal.preparing || work.preparing}
                  sessionKey={String(state.selectedSessionId ?? 'none')}
                  onTranscribed={handleVoiceTranscribed}
                />
                <button
                  className="explorer__primary session__send session__send--fab"
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sendDisabled}
                  aria-label="Send message"
                  title="Send message"
                >
                  <UiIcon name="arrow-up" size={18} />
                </button>
              </div>
            </div>
            {targetBlockedNotice !== null && (
              <p className="session__hint" role="status">
                {targetBlockedNotice}
              </p>
            )}
            {proposeGated && (
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
            {extensionOutcome !== null &&
              extensionOutcome.sessionId === state.selectedSessionId &&
              extensionOutcome.transactionIds.length > 0 && (
                <div className="session__generation-error" role="status" aria-label="Extension proposal ready">
                  <p className="session__status">
                    Proposal ready · {extensionOutcome.transactionIds.length} file
                    {extensionOutcome.transactionIds.length === 1 ? '' : 's'}
                  </p>
                  <button
                    className="explorer__secondary"
                    type="button"
                    onClick={() => onReviewTransaction(extensionOutcome.transactionIds[0] ?? 0)}
                  >
                    Review change
                  </button>
                </div>
              )}
          </div>
        </>
      )}
    </section>
  )
}
