import type { CloudAccountStatus } from '../../../../shared/cloud-account/types'

/**
 * Pure STARK account panel state (no React imports) so status loading,
 * explicit sign-in/out, cancellation, pushed updates, and error copy
 * are unit-testable with the Node runner. No timers, no polling, no
 * autosave, no token handling — the renderer only sees safe statuses.
 */

export interface AccountPanelState {
  readonly loading: boolean
  readonly loadError: string | null
  readonly status: CloudAccountStatus | null
  readonly acting: boolean
  readonly actionError: string | null
  readonly notice: string | null
}

export function initialAccountPanelState(): AccountPanelState {
  return {
    loading: false,
    loadError: null,
    status: null,
    acting: false,
    actionError: null,
    notice: null
  }
}

export type AccountPanelAction =
  | { readonly type: 'status-loading' }
  | { readonly type: 'status-loaded'; readonly status: CloudAccountStatus }
  | { readonly type: 'status-failed'; readonly message: string }
  | { readonly type: 'action-started' }
  | { readonly type: 'action-succeeded'; readonly status: CloudAccountStatus; readonly notice: string | null }
  | { readonly type: 'action-failed'; readonly message: string }
  | { readonly type: 'pushed'; readonly status: CloudAccountStatus }
  | { readonly type: 'notice-dismissed' }

export function accountPanelReducer(state: AccountPanelState, action: AccountPanelAction): AccountPanelState {
  switch (action.type) {
    case 'status-loading':
      return { ...state, loading: true, loadError: null }
    case 'status-loaded':
      return { ...state, loading: false, loadError: null, status: action.status }
    case 'status-failed':
      return { ...state, loading: false, loadError: action.message }
    case 'action-started':
      if (state.acting) {
        return state
      }
      return { ...state, acting: true, actionError: null, notice: null }
    case 'action-succeeded':
      return { ...state, acting: false, actionError: null, notice: action.notice, status: action.status }
    case 'action-failed':
      return { ...state, acting: false, actionError: action.message }
    case 'pushed':
      return { ...state, status: action.status }
    case 'notice-dismissed':
      return { ...state, notice: null }
  }
}

/** Provider label for safe account copy (never a token or URL). */
export function accountProviderLabel(provider: 'google' | 'github'): string {
  return provider === 'google' ? 'Google' : 'GitHub'
}

/** Initials fallback when no safe avatar is rendered (security > avatar). */
export function accountInitials(displayName: string | null, email: string | null): string {
  const source = (displayName ?? '').trim() !== '' ? (displayName as string).trim() : (email ?? '').trim()
  if (source === '') {
    return 'S'
  }
  const parts = source.split(/\s+/).filter((part) => part !== '')
  if (parts.length === 0) {
    return 'S'
  }
  if (parts.length === 1) {
    return [...(parts[0] as string)].slice(0, 2).join('').toUpperCase()
  }
  const first = [...(parts[0] as string)][0] ?? 'S'
  const last = [...(parts[parts.length - 1] as string)][0] ?? ''
  return `${first}${last}`.toUpperCase()
}

/**
 * Validates that a pushed status carries no secret-bearing keys.
 * Mirrors the preload guard for renderer-state tests.
 */
export function isSafeAccountStatusPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const serialized = JSON.stringify(value)
  for (const forbidden of ['accessToken', 'refreshToken', 'access_token', 'refresh_token', 'oauthUrl', 'redirectUrl', 'verifier']) {
    if (serialized.includes(forbidden)) {
      return false
    }
  }
  return true
}
