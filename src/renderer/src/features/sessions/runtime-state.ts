import type { ProjectRuntimeSummary } from '../../../../shared/project-runtime/types'

/**
 * Pure Stage 26 runtime UX state (no React imports) so active-runtime
 * display, history, errors, and workspace isolation are unit-testable
 * with the Node runner. Mirrors the work-state pattern: cross-workspace
 * outcomes are rejected, switching workspaces resets everything. No
 * timers, no countdowns, no polling, no automatic actions live here —
 * the main process owns lifetime; the renderer only reflects pushed or
 * explicitly loaded state.
 */

export interface RuntimePanelState {
  readonly workspaceId: number | null
  readonly active: ProjectRuntimeSummary | null
  readonly history: readonly ProjectRuntimeSummary[]
  readonly acting: boolean
  readonly error: string | null
}

export function initialRuntimePanelState(): RuntimePanelState {
  return { workspaceId: null, active: null, history: [], acting: false, error: null }
}

export type RuntimePanelAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'active-loaded'; readonly workspaceId: number; readonly active: ProjectRuntimeSummary | null }
  | { readonly type: 'history-loaded'; readonly workspaceId: number; readonly history: readonly ProjectRuntimeSummary[] }
  | { readonly type: 'updated'; readonly workspaceId: number; readonly active: ProjectRuntimeSummary | null }
  | { readonly type: 'action-started'; readonly workspaceId: number }
  | { readonly type: 'action-succeeded'; readonly workspaceId: number; readonly active: ProjectRuntimeSummary | null }
  | { readonly type: 'action-failed'; readonly workspaceId: number; readonly message: string }
  | { readonly type: 'error-dismissed'; readonly workspaceId: number }

export function runtimePanelReducer(state: RuntimePanelState, action: RuntimePanelAction): RuntimePanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialRuntimePanelState(), workspaceId: action.workspaceId }
    case 'active-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, active: action.active, error: null }
    }
    case 'history-loaded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, history: action.history }
    }
    case 'updated': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, active: action.active }
    }
    case 'action-started': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      if (state.acting) {
        return state
      }
      return { ...state, acting: true, error: null }
    }
    case 'action-succeeded': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, acting: false, active: action.active, error: null }
    }
    case 'action-failed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, acting: false, error: action.message }
    }
    case 'error-dismissed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...state, error: null }
    }
  }
}

/** Truncation notice for bounded Worker Preview snapshots (inert text). */
export const PREVIEW_TRUNCATION_NOTICE =
  'Some Preview content was omitted to stay within the inspection limit.'

/** Inert one-line label for a bounded Preview element (no values, no HTML). */
export function formatPreviewElementForDisplay(element: {
  readonly tag: string
  readonly role: string | null
  readonly type: string | null
  readonly name: string | null
  readonly ariaLabel: string | null
  readonly text: string
  readonly href: string | null
}): string {
  const label = element.ariaLabel ?? element.name ?? element.text
  const trimmed = label.trim().slice(0, 80)
  const kind = element.tag === 'a' ? 'Link' : element.tag === 'button' ? 'Button' : element.tag === 'input' ? 'Input' : element.tag
  if (element.href !== null && element.href !== '') {
    return `${kind} — "${trimmed}" — ${element.href}`
  }
  return `${kind} — "${trimmed}"`
}

/** Human-readable one-line status for an active runtime card. */
export function runtimeStatusLabel(status: ProjectRuntimeSummary['status']): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'stopped':
      return 'Stopped'
    case 'exited':
      return 'Exited'
    case 'timed_out':
      return 'Timed out'
    case 'spawn_failed':
      return 'Failed to start'
    case 'interrupted':
      return 'Interrupted'
  }
}
