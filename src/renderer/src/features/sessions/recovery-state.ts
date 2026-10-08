import type { RecoveryAssignment, RecoveryConfig, RecoveryEvent, RecoveryMode } from '../../../../shared/recovery/types'

/**
 * Pure Recovery settings state (no React imports) so config loading,
 * draft editing, explicit save, and workspace isolation are
 * unit-testable with the Node runner. Draft edits never persist on
 * their own — only an explicit Save dispatches through the bridge.
 * No timers, no polling, no autosave lives here.
 */

export interface RecoveryAssignmentDraft {
  providerId: string
  model: string
}

export interface RecoveryDraft {
  mode: RecoveryMode
  ask: RecoveryAssignmentDraft
  brain: RecoveryAssignmentDraft
  worker: RecoveryAssignmentDraft
}

export function emptyRecoveryDraft(): RecoveryDraft {
  const blank = (): RecoveryAssignmentDraft => ({ providerId: 'openai', model: '' })
  return { mode: 'off', ask: blank(), brain: blank(), worker: blank() }
}

export function recoveryDraftFromConfig(config: RecoveryConfig): RecoveryDraft {
  const blank = (): RecoveryAssignmentDraft => ({ providerId: 'openai', model: '' })
  const pick = (assignment: RecoveryAssignment | null): RecoveryAssignmentDraft =>
    assignment === null ? blank() : { providerId: assignment.providerId, model: assignment.model }
  return { mode: config.mode, ask: pick(config.ask), brain: pick(config.brain), worker: pick(config.worker) }
}

export interface RecoveryPanelState {
  readonly workspaceId: number | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly config: RecoveryConfig | null
  readonly draft: RecoveryDraft
  readonly saving: boolean
  readonly saveError: string | null
  readonly notice: string | null
  readonly event: RecoveryEvent | null
  readonly eventError: string | null
}

export function initialRecoveryPanelState(): RecoveryPanelState {
  return {
    workspaceId: null,
    loading: false,
    loadError: null,
    config: null,
    draft: emptyRecoveryDraft(),
    saving: false,
    saveError: null,
    notice: null,
    event: null,
    eventError: null
  }
}

export type RecoveryDraftField = { readonly scope: 'ask' | 'brain' | 'worker' }

export type RecoveryPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'config-loading'; readonly workspaceId: number }
  | { readonly type: 'config-loaded'; readonly workspaceId: number; readonly config: RecoveryConfig | null }
  | { readonly type: 'config-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'mode-selected'; readonly workspaceId: number; readonly mode: RecoveryMode }
  | { readonly type: 'draft-edited'; readonly workspaceId: number; readonly field: RecoveryDraftField; readonly providerId: string; readonly model: string }
  | { readonly type: 'save-started'; readonly workspaceId: number }
  | { readonly type: 'save-succeeded'; readonly workspaceId: number; readonly config: RecoveryConfig }
  | { readonly type: 'save-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'event-loaded'; readonly workspaceId: number; readonly event: RecoveryEvent | null }
  | { readonly type: 'event-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'notice-dismissed'; readonly workspaceId: number }

export function recoveryPanelReducer(state: RecoveryPanelState, action: RecoveryPanelAction): RecoveryPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialRecoveryPanelState(), workspaceId: action.workspaceId }
    case 'config-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loading: true, loadError: null }
    }
    case 'config-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        loading: false,
        loadError: null,
        config: action.config,
        draft: action.config === null ? emptyRecoveryDraft() : recoveryDraftFromConfig(action.config)
      }
    }
    case 'config-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loading: false, loadError: action.message }
    }
    case 'mode-selected': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, draft: { ...state.draft, mode: action.mode }, notice: null }
    }
    case 'draft-edited': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        draft: { ...state.draft, [action.field.scope]: { providerId: action.providerId, model: action.model } },
        notice: null
      }
    }
    case 'save-started': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      if (state.saving) {
        return state
      }
      return { ...state, saving: true, saveError: null, notice: null }
    }
    case 'save-succeeded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        saving: false,
        saveError: null,
        notice: 'Recovery configuration saved.',
        config: action.config,
        draft: recoveryDraftFromConfig(action.config)
      }
    }
    case 'save-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, saving: false, saveError: action.message }
    }
    case 'event-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, event: action.event, eventError: null }
    }
    case 'event-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, eventError: action.message }
    }
    case 'notice-dismissed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, notice: null }
    }
  }
}

/**
 * Renderer-safe source copy for a recovery event. Never includes raw
 * provider error bodies, credentials, or countdowns.
 */
export function recoverySourceCopy(status: RecoveryEvent['status']): string {
  switch (status) {
    case 'handoff_ready':
      return 'STARK created a recovery session.'
    case 'running':
      return 'STARK is continuing in a recovery session…'
    case 'succeeded':
      return 'STARK continued this request in a recovery session.'
    case 'failed':
      return 'Recovery attempt failed. No further automatic attempts will be made.'
    case 'dismissed':
      return 'Recovery handoff dismissed.'
    case 'interrupted':
      return 'Recovery was interrupted. Continue manually if needed.'
  }
}

/** Renderer-safe target banner copy for a recovery event. */
export function recoveryTargetCopy(event: RecoveryEvent): string {
  const policy = event.policyMode === 'auto_once' ? 'Auto once' : event.policyMode === 'handoff' ? 'Handoff only' : event.policyMode
  return `Recovery handoff — ${event.failureCategory} — ${policy} — ${event.status}`
}
