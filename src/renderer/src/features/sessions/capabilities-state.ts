import type {
  AgentCapability,
  CapabilityPolicyMode,
  WorkspaceCapabilityConfig
} from '../../../../shared/capabilities/types'

/**
 * Pure capability settings state (no React imports) so config
 * loading, draft editing, explicit save, and workspace isolation are
 * unit-testable with the Node runner. Draft edits never persist on
 * their own — only an explicit Save dispatches through the bridge.
 * No timers, no polling, no autosave, no tool execution lives here.
 */

export const CAPABILITY_ORDER: readonly AgentCapability[] = [
  'workspace.read',
  'workspace.search',
  'git.read',
  'change.propose',
  'terminal.execute'
]

export function capabilityLabel(capability: AgentCapability): string {
  switch (capability) {
    case 'workspace.read':
      return 'Workspace file read'
    case 'workspace.search':
      return 'Workspace search'
    case 'git.read':
      return 'Git read'
    case 'change.propose':
      return 'Change proposal'
    case 'terminal.execute':
      return 'Terminal execute'
  }
}

export function legalModesFor(capability: AgentCapability): readonly CapabilityPolicyMode[] {
  return capability === 'terminal.execute' ? ['deny', 'ask'] : ['deny', 'ask', 'allow']
}

export interface CapabilityDraft {
  enabled: boolean
  modes: Record<AgentCapability, CapabilityPolicyMode>
}

export function emptyCapabilityDraft(): CapabilityDraft {
  return {
    enabled: false,
    modes: {
      'workspace.read': 'deny',
      'workspace.search': 'deny',
      'git.read': 'deny',
      'change.propose': 'deny',
      'terminal.execute': 'deny'
    }
  }
}

export function capabilityDraftFromConfig(config: WorkspaceCapabilityConfig): CapabilityDraft {
  const modes: Record<AgentCapability, CapabilityPolicyMode> = {
    'workspace.read': 'deny',
    'workspace.search': 'deny',
    'git.read': 'deny',
    'change.propose': 'deny',
    'terminal.execute': 'deny'
  }
  for (const policy of config.policies) {
    modes[policy.capability] = policy.mode
  }
  return { enabled: config.enabled, modes }
}

export interface CapabilityPanelState {
  readonly workspaceId: number | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly config: WorkspaceCapabilityConfig | null
  readonly draft: CapabilityDraft
  readonly saving: boolean
  readonly saveError: string | null
  readonly notice: string | null
}

export function initialCapabilityPanelState(): CapabilityPanelState {
  return {
    workspaceId: null,
    loading: false,
    loadError: null,
    config: null,
    draft: emptyCapabilityDraft(),
    saving: false,
    saveError: null,
    notice: null
  }
}

export type CapabilityPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'config-loading'; readonly workspaceId: number }
  | { readonly type: 'config-loaded'; readonly workspaceId: number; readonly config: WorkspaceCapabilityConfig }
  | { readonly type: 'config-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'enabled-toggled'; readonly workspaceId: number; readonly enabled: boolean }
  | { readonly type: 'mode-selected'; readonly workspaceId: number; readonly capability: AgentCapability; readonly mode: CapabilityPolicyMode }
  | { readonly type: 'save-started'; readonly workspaceId: number }
  | { readonly type: 'save-succeeded'; readonly workspaceId: number; readonly config: WorkspaceCapabilityConfig }
  | { readonly type: 'save-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'notice-dismissed'; readonly workspaceId: number }

export function capabilityPanelReducer(state: CapabilityPanelState, action: CapabilityPanelAction): CapabilityPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialCapabilityPanelState(), workspaceId: action.workspaceId }
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
        draft: capabilityDraftFromConfig(action.config)
      }
    }
    case 'config-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loading: false, loadError: action.message }
    }
    case 'enabled-toggled': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      // Master toggle edits the draft only — the gate still denies
      // while disabled, and configured modes are preserved for later.
      return { ...state, draft: { ...state.draft, enabled: action.enabled }, notice: null }
    }
    case 'mode-selected': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      if (action.capability === 'terminal.execute' && action.mode === 'allow') {
        return state
      }
      return {
        ...state,
        draft: { ...state.draft, modes: { ...state.draft.modes, [action.capability]: action.mode } },
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
        notice: 'Workspace permissions saved.',
        config: action.config,
        draft: capabilityDraftFromConfig(action.config)
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
