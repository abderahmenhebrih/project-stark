import type {
  AiProviderState,
  ProviderConnectionStatus,
  ProviderModel
} from '../../../../shared/providers/types'

/**
 * Pure provider-settings state (no React imports) so configured,
 * storage, connection, model-list, and selection transitions are
 * unit-testable with the Node runner. Mirrors the session-state
 * pattern: stale and cross-workspace results are rejected. No
 * polling, no auto-refresh — every fetch is an explicit user action.
 */

export type ProviderConnectionPhase = 'idle' | 'testing' | 'done' | 'error'

export interface ProviderPanelState {
  readonly workspaceId: number | null
  readonly configured: boolean
  readonly secureStorageAvailable: boolean
  readonly selectedModel: string | null
  readonly displayName: string
  readonly loading: boolean
  readonly error: string | null
  readonly requestId: number
  readonly models: readonly ProviderModel[]
  readonly loadingModels: boolean
  readonly modelsError: string | null
  readonly modelsRequestId: number
  readonly connectionPhase: ProviderConnectionPhase
  readonly connectionStatus: ProviderConnectionStatus | null
  readonly connectionError: string | null
  readonly connectionRequestId: number
}

export function initialProviderPanelState(): ProviderPanelState {
  return {
    workspaceId: null,
    configured: false,
    secureStorageAvailable: true,
    selectedModel: null,
    displayName: 'OpenAI',
    loading: false,
    error: null,
    requestId: 0,
    models: [],
    loadingModels: false,
    modelsError: null,
    modelsRequestId: 0,
    connectionPhase: 'idle',
    connectionStatus: null,
    connectionError: null,
    connectionRequestId: 0
  }
}

export type ProviderPanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'state-loading'; readonly workspaceId: number; readonly requestId: number }
  | { readonly type: 'state-loaded'; readonly workspaceId: number; readonly requestId: number; readonly state: AiProviderState }
  | { readonly type: 'state-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'models-loading'; readonly workspaceId: number; readonly requestId: number }
  | {
      readonly type: 'models-loaded'
      readonly workspaceId: number
      readonly requestId: number
      readonly models: readonly ProviderModel[]
    }
  | { readonly type: 'models-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }
  | { readonly type: 'connection-started'; readonly workspaceId: number; readonly requestId: number }
  | {
      readonly type: 'connection-finished'
      readonly workspaceId: number
      readonly requestId: number
      readonly status: ProviderConnectionStatus
      readonly models: readonly ProviderModel[]
    }
  | { readonly type: 'connection-failed'; readonly workspaceId: number; readonly requestId: number; readonly message: string }

function isCurrent(state: ProviderPanelState, workspaceId: number, requestId: number, counter: number): boolean {
  return state.workspaceId === workspaceId && counter === requestId
}

export function providerPanelReducer(state: ProviderPanelState, action: ProviderPanelAction): ProviderPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialProviderPanelState(), workspaceId: action.workspaceId }
    case 'state-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loading: true, error: null, requestId: action.requestId }
    }
    case 'state-loaded': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.requestId)) {
        return state
      }
      return {
        ...state,
        loading: false,
        error: null,
        configured: action.state.configured,
        secureStorageAvailable: action.state.secureStorageAvailable,
        selectedModel: action.state.selectedModel,
        displayName: action.state.displayName
      }
    }
    case 'state-failed': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.requestId)) {
        return state
      }
      return { ...state, loading: false, error: action.message }
    }
    case 'models-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loadingModels: true, modelsError: null, modelsRequestId: action.requestId }
    }
    case 'models-loaded': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.modelsRequestId)) {
        return state
      }
      return { ...state, loadingModels: false, modelsError: null, models: action.models }
    }
    case 'models-failed': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.modelsRequestId)) {
        return state
      }
      return { ...state, loadingModels: false, modelsError: action.message }
    }
    case 'connection-started': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        connectionPhase: 'testing',
        connectionStatus: null,
        connectionError: null,
        connectionRequestId: action.requestId
      }
    }
    case 'connection-finished': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.connectionRequestId)) {
        return state
      }
      return {
        ...state,
        connectionPhase: 'done',
        connectionStatus: action.status,
        connectionError: null,
        // A successful test reuses its single response for the model
        // list, so no second network call is needed.
        models: action.status === 'connected' ? action.models : state.models
      }
    }
    case 'connection-failed': {
      if (!isCurrent(state, action.workspaceId, action.requestId, state.connectionRequestId)) {
        return state
      }
      return { ...state, connectionPhase: 'error', connectionStatus: null, connectionError: action.message }
    }
  }
}
