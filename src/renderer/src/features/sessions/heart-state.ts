import type { HeartAssignment, HeartConfig, HeartWorkerMode } from '../../../../shared/heart/types'

/**
 * Pure Heart settings state (no React imports) so config loading,
 * draft editing, explicit save, and workspace isolation are
 * unit-testable with the Node runner. Draft edits never persist on
 * their own — only an explicit Save dispatches through the bridge.
 * No timers, no polling, no autosave lives here.
 */

export interface HeartAssignmentDraft {
  providerId: string
  model: string
}

export interface HeartDraft {
  workerMode: HeartWorkerMode
  brain: HeartAssignmentDraft
  workerFixed: HeartAssignmentDraft
  workerDefault: HeartAssignmentDraft
  workerRoutes: Record<'general' | 'coding' | 'reasoning' | 'fast', HeartAssignmentDraft>
}

export function emptyHeartDraft(): HeartDraft {
  const blank = (): HeartAssignmentDraft => ({ providerId: 'openai', model: '' })
  return {
    workerMode: 'fixed',
    brain: blank(),
    workerFixed: blank(),
    workerDefault: blank(),
    workerRoutes: { general: blank(), coding: blank(), reasoning: blank(), fast: blank() }
  }
}

export function heartDraftFromConfig(config: HeartConfig): HeartDraft {
  const blank = (): HeartAssignmentDraft => ({ providerId: 'openai', model: '' })
  const pick = (assignment: HeartAssignment | null): HeartAssignmentDraft =>
    assignment === null ? blank() : { providerId: assignment.providerId, model: assignment.model }
  return {
    workerMode: config.workerMode,
    brain: pick(config.brain),
    workerFixed: pick(config.workerFixed),
    workerDefault: pick(config.workerDefault),
    workerRoutes: {
      general: pick(config.workerRoutes.general),
      coding: pick(config.workerRoutes.coding),
      reasoning: pick(config.workerRoutes.reasoning),
      fast: pick(config.workerRoutes.fast)
    }
  }
}

export interface HeartPanelState {
  readonly workspaceId: number | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly config: HeartConfig | null
  readonly draft: HeartDraft
  readonly saving: boolean
  readonly saveError: string | null
  readonly notice: string | null
}

export function initialHeartPanelState(): HeartPanelState {
  return {
    workspaceId: null,
    loading: false,
    loadError: null,
    config: null,
    draft: emptyHeartDraft(),
    saving: false,
    saveError: null,
    notice: null
  }
}

export type HeartDraftField =
  | { readonly scope: 'brain' | 'workerFixed' | 'workerDefault' }
  | { readonly scope: 'route'; readonly profile: 'general' | 'coding' | 'reasoning' | 'fast' }

export type HeartPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'config-loading'; readonly workspaceId: number }
  | { readonly type: 'config-loaded'; readonly workspaceId: number; readonly config: HeartConfig | null }
  | { readonly type: 'config-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'mode-selected'; readonly workspaceId: number; readonly mode: HeartWorkerMode }
  | { readonly type: 'draft-edited'; readonly workspaceId: number; readonly field: HeartDraftField; readonly providerId: string; readonly model: string }
  | { readonly type: 'save-started'; readonly workspaceId: number }
  | { readonly type: 'save-succeeded'; readonly workspaceId: number; readonly config: HeartConfig }
  | { readonly type: 'save-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'notice-dismissed'; readonly workspaceId: number }

function assignmentAt(draft: HeartDraft, field: HeartDraftField): HeartAssignmentDraft {
  if (field.scope === 'route') {
    return draft.workerRoutes[field.profile]
  }
  return draft[field.scope]
}

export function heartPanelReducer(state: HeartPanelState, action: HeartPanelAction): HeartPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialHeartPanelState(), workspaceId: action.workspaceId }
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
        draft: action.config === null ? emptyHeartDraft() : heartDraftFromConfig(action.config)
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
      // Mode toggle edits the draft only — nothing persists until Save.
      return { ...state, draft: { ...state.draft, workerMode: action.mode }, notice: null }
    }
    case 'draft-edited': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      const current = assignmentAt(state.draft, action.field)
      const updated = { ...current, providerId: action.providerId, model: action.model }
      if (action.field.scope === 'route') {
        return {
          ...state,
          draft: { ...state.draft, workerRoutes: { ...state.draft.workerRoutes, [action.field.profile]: updated } },
          notice: null
        }
      }
      return { ...state, draft: { ...state.draft, [action.field.scope]: updated }, notice: null }
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
        notice: 'Heart configuration saved.',
        config: action.config,
        draft: heartDraftFromConfig(action.config)
      }
    }
    case 'save-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, saving: false, saveError: action.message }
    }
    case 'notice-dismissed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, notice: null }
    }
  }
}
