import type {
  UsageConfig,
  UsageModelSummary,
  UsageSummary,
  UsageThresholdRouteKey
} from '../../../../shared/usage/types'

/**
 * Pure local usage-awareness panel state (no React imports) so
 * config loading, draft editing, explicit save, summary refresh,
 * and workspace isolation are unit-testable with the Node runner.
 * Draft edits never persist on their own — only an explicit Save
 * dispatches through the bridge. No timers, no polling, no
 * autosave, no provider calls live here.
 */

export const USAGE_ROUTE_KEYS: readonly UsageThresholdRouteKey[] = [
  'brain.primary',
  'worker.fixed',
  'worker.default',
  'worker.general',
  'worker.coding',
  'worker.reasoning',
  'worker.fast'
]

export function usageRouteLabel(routeKey: UsageThresholdRouteKey): string {
  switch (routeKey) {
    case 'brain.primary':
      return 'Brain'
    case 'worker.fixed':
      return 'Worker Fixed'
    case 'worker.default':
      return 'Worker Default'
    case 'worker.general':
      return 'Worker General'
    case 'worker.coding':
      return 'Worker Coding'
    case 'worker.reasoning':
      return 'Worker Reasoning'
    case 'worker.fast':
      return 'Worker Fast'
  }
}

/** One editable limit row (text inputs; empty means unset). */
export interface UsageLimitDraft {
  readonly providerId: string
  readonly model: string
  readonly maxCalls: string
  readonly maxTokens: string
  readonly switchAt: string
}

/** One editable alternate (empty model means none configured). */
export interface UsageAlternateDraft {
  readonly providerId: string
  readonly model: string
}

export interface UsageDraft {
  readonly thresholdRoutingEnabled: boolean
  readonly limits: readonly UsageLimitDraft[]
  readonly alternates: Record<UsageThresholdRouteKey, UsageAlternateDraft>
}

export function emptyUsageDraft(): UsageDraft {
  const blank = (): UsageAlternateDraft => ({ providerId: 'openai', model: '' })
  return {
    thresholdRoutingEnabled: false,
    limits: [],
    alternates: {
      'brain.primary': blank(),
      'worker.fixed': blank(),
      'worker.default': blank(),
      'worker.general': blank(),
      'worker.coding': blank(),
      'worker.reasoning': blank(),
      'worker.fast': blank()
    }
  }
}

export function usageDraftFromConfig(config: UsageConfig): UsageDraft {
  const blank = (): UsageAlternateDraft => ({ providerId: 'openai', model: '' })
  const alternates: Record<UsageThresholdRouteKey, UsageAlternateDraft> = {
    'brain.primary': blank(),
    'worker.fixed': blank(),
    'worker.default': blank(),
    'worker.general': blank(),
    'worker.coding': blank(),
    'worker.reasoning': blank(),
    'worker.fast': blank()
  }
  for (const entry of config.alternates) {
    alternates[entry.routeKey] = { providerId: entry.providerId, model: entry.model }
  }
  return {
    thresholdRoutingEnabled: config.heartThresholdRoutingEnabled,
    limits: config.limits.map((entry) => ({
      providerId: entry.providerId,
      model: entry.model,
      maxCalls: entry.maxCalls24h === null ? '' : String(entry.maxCalls24h),
      maxTokens: entry.maxTotalTokens24h === null ? '' : String(entry.maxTotalTokens24h),
      switchAt: String(entry.switchAtPercent)
    })),
    alternates
  }
}

export interface UsagePanelState {
  readonly workspaceId: number | null
  readonly loading: boolean
  readonly loadError: string | null
  readonly config: UsageConfig | null
  readonly draft: UsageDraft
  readonly saving: boolean
  readonly saveError: string | null
  readonly notice: string | null
  readonly summary: UsageSummary | null
  readonly summaryLoading: boolean
  readonly summaryError: string | null
}

export function initialUsagePanelState(): UsagePanelState {
  return {
    workspaceId: null,
    loading: false,
    loadError: null,
    config: null,
    draft: emptyUsageDraft(),
    saving: false,
    saveError: null,
    notice: null,
    summary: null,
    summaryLoading: false,
    summaryError: null
  }
}

export type UsagePanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'config-loading'; readonly workspaceId: number }
  | { readonly type: 'config-loaded'; readonly workspaceId: number; readonly config: UsageConfig }
  | { readonly type: 'config-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'summary-loading'; readonly workspaceId: number }
  | { readonly type: 'summary-loaded'; readonly workspaceId: number; readonly summary: UsageSummary }
  | { readonly type: 'summary-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'routing-toggled'; readonly workspaceId: number; readonly enabled: boolean }
  | { readonly type: 'limit-added'; readonly workspaceId: number }
  | { readonly type: 'limit-removed'; readonly workspaceId: number; readonly index: number }
  | { readonly type: 'limit-edited'; readonly workspaceId: number; readonly index: number; readonly limit: UsageLimitDraft }
  | { readonly type: 'alternate-edited'; readonly workspaceId: number; readonly routeKey: UsageThresholdRouteKey; readonly alternate: UsageAlternateDraft }
  | { readonly type: 'save-started'; readonly workspaceId: number }
  | { readonly type: 'save-succeeded'; readonly workspaceId: number; readonly config: UsageConfig }
  | { readonly type: 'save-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'notice-dismissed'; readonly workspaceId: number }

export function usagePanelReducer(state: UsagePanelState, action: UsagePanelAction): UsagePanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialUsagePanelState(), workspaceId: action.workspaceId }
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
        draft: usageDraftFromConfig(action.config)
      }
    }
    case 'config-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, loading: false, loadError: action.message }
    }
    case 'summary-loading': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, summaryLoading: true, summaryError: null }
    }
    case 'summary-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, summaryLoading: false, summaryError: null, summary: action.summary }
    }
    case 'summary-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, summaryLoading: false, summaryError: action.message }
    }
    case 'routing-toggled': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, draft: { ...state.draft, thresholdRoutingEnabled: action.enabled }, notice: null }
    }
    case 'limit-added': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        draft: {
          ...state.draft,
          limits: [...state.draft.limits, { providerId: 'openai', model: '', maxCalls: '', maxTokens: '', switchAt: '90' }]
        },
        notice: null
      }
    }
    case 'limit-removed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        draft: { ...state.draft, limits: state.draft.limits.filter((_, index) => index !== action.index) },
        notice: null
      }
    }
    case 'limit-edited': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        draft: {
          ...state.draft,
          limits: state.draft.limits.map((entry, index) => (index === action.index ? action.limit : entry))
        },
        notice: null
      }
    }
    case 'alternate-edited': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return {
        ...state,
        draft: { ...state.draft, alternates: { ...state.draft.alternates, [action.routeKey]: action.alternate } },
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
        notice: 'Usage routing saved.',
        config: action.config,
        draft: usageDraftFromConfig(action.config)
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

/** Human-readable configured-threshold text for a model row (inert text). */
export function formatUsageThreshold(row: UsageModelSummary): string {
  if (row.maxCalls24h === null && row.maxTotalTokens24h === null) {
    return 'No routing threshold'
  }
  const parts: string[] = []
  if (row.maxCalls24h !== null) {
    parts.push(`${String(row.maxCalls24h)} calls`)
  }
  if (row.maxTotalTokens24h !== null) {
    parts.push(`${String(row.maxTotalTokens24h)} tokens`)
  }
  const at = row.switchAtPercent === null ? '' : ` at ${String(row.switchAtPercent)}%`
  return `Threshold: ${parts.join(' / ')}${at}`
}

/** Human-readable one-line summary for a model row (inert text). */
export function formatUsageModelRow(row: UsageModelSummary): string {
  const tokens =
    row.tokenTelemetryComplete && row.totalTokens24h !== null
      ? `${String(row.totalTokens24h)} tokens`
      : 'Token telemetry incomplete'
  const threshold = row.thresholdReached ? 'Threshold reached' : 'Below threshold'
  return `${row.providerId} / ${row.model} · ${String(row.calls24h)} calls · ${tokens} · ${threshold}`
}
