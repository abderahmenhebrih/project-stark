import type { SessionContextDraft } from '../../../../shared/context/types'
import type { ChangeTransaction } from '../../../../shared/change-transactions/types'
import type { ChangeSet } from '../../../../shared/change-sets/types'

/**
 * Pure proposal UX state (Stage 16 single-file + Stage 17 Change
 * Sets; no React imports) so composer mode, eligibility,
 * preparing/result/error, and workspace/session isolation are
 * unit-testable with the Node runner. Mirrors the session pattern:
 * cross-workspace and cross-session outcomes are rejected, switching
 * clears transient proposal results. No timers, no polling, no
 * auto-retry lives here.
 */

export type ProposalMode = 'ask' | 'work' | 'propose'

export interface ProposalResult {
  readonly transaction: ChangeTransaction
  readonly summary: string
}

export interface ChangeSetProposalResult {
  readonly changeSet: ChangeSet
}

export interface ProposalPanelState {
  readonly workspaceId: number | null
  readonly sessionId: number | null
  readonly mode: ProposalMode
  readonly preparing: boolean
  /** Which proposal path the current flight (or last failure) used; drives explicit Retry. */
  readonly activeKind: 'single' | 'multi' | null
  readonly result: ProposalResult | null
  readonly changeSet: ChangeSetProposalResult | null
  readonly error: string | null
}

export function initialProposalState(): ProposalPanelState {
  return { workspaceId: null, sessionId: null, mode: 'ask', preparing: false, activeKind: null, result: null, changeSet: null, error: null }
}

export type ProposalAction =
  | { readonly type: 'workspace-changed'; readonly workspaceId: number }
  | { readonly type: 'session-changed'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'mode-changed'; readonly workspaceId: number; readonly mode: ProposalMode }
  | { readonly type: 'proposal-started'; readonly workspaceId: number; readonly sessionId: number; readonly kind: 'single' | 'multi' }
  | {
      readonly type: 'proposal-succeeded'
      readonly workspaceId: number
      readonly sessionId: number
      readonly result: ProposalResult
    }
  | {
      readonly type: 'change-set-succeeded'
      readonly workspaceId: number
      readonly sessionId: number
      readonly changeSet: ChangeSet
    }
  | { readonly type: 'proposal-failed'; readonly workspaceId: number; readonly sessionId: number; readonly message: string }
  | { readonly type: 'proposal-dismissed'; readonly workspaceId: number; readonly sessionId: number }
  | { readonly type: 'proposal-retried'; readonly workspaceId: number; readonly sessionId: number }

/** Which proposal path the current drafts select, if any. */
export type ProposalKind = 'none' | 'single' | 'multi'

/**
 * Proposal eligibility for the current draft list.
 * - 1 whole-file (+ notes only): single-file Stage 16 proposal
 * - 2–5 whole files (+ notes only): Stage 17 Change Set proposal
 * - anything else: blocked with guidance copy
 */
export function proposalEligibility(drafts: readonly SessionContextDraft[]): {
  readonly eligible: boolean
  readonly kind: ProposalKind
  readonly reason: string | null
} {
  const whole = drafts.filter((entry) => entry.kind === 'whole-file')
  const excerpt = drafts.filter((entry) => entry.kind === 'file-excerpt')
  const search = drafts.filter((entry) => entry.kind === 'search-match')
  if (excerpt.length !== 0 || search.length !== 0) {
    return { eligible: false, kind: 'none', reason: 'Code proposals require whole-file attachments only.' }
  }
  if (whole.length === 0) {
    return { eligible: false, kind: 'none', reason: 'Attach one or more whole files to propose code changes.' }
  }
  if (whole.length > 5) {
    return { eligible: false, kind: 'none', reason: 'STARK can propose changes to at most 5 files at once.' }
  }
  if (whole.length === 1) {
    return { eligible: true, kind: 'single', reason: null }
  }
  return { eligible: true, kind: 'multi', reason: null }
}

function isCurrent(state: ProposalPanelState, workspaceId: number, sessionId: number): boolean {
  return state.workspaceId === workspaceId && state.sessionId === sessionId
}

export function proposalReducer(state: ProposalPanelState, action: ProposalAction): ProposalPanelState {
  switch (action.type) {
    case 'workspace-changed':
      return { ...initialProposalState(), workspaceId: action.workspaceId }
    case 'session-changed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      return { ...initialProposalState(), workspaceId: action.workspaceId, sessionId: action.sessionId }
    }
    case 'mode-changed': {
      if (state.workspaceId !== action.workspaceId) {
        return state
      }
      // Switching modes never auto-starts work; a stale result from the
      // other mode is dropped so Ask never shows proposal state.
      if (action.mode === 'ask') {
        return { ...state, mode: 'ask', preparing: false, activeKind: null, result: null, changeSet: null, error: null }
      }
      return { ...state, mode: action.mode }
    }
    case 'proposal-started': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.preparing) {
        return state
      }
      return { ...state, preparing: true, activeKind: action.kind, result: null, changeSet: null, error: null }
    }
    case 'proposal-succeeded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, preparing: false, result: action.result, changeSet: null, error: null }
    }
    case 'change-set-succeeded': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, preparing: false, result: null, changeSet: { changeSet: action.changeSet }, error: null }
    }
    case 'proposal-failed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, preparing: false, result: null, changeSet: null, error: action.message }
    }
    case 'proposal-dismissed': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      return { ...state, result: null, changeSet: null, error: null }
    }
    case 'proposal-retried': {
      if (!isCurrent(state, action.workspaceId, action.sessionId)) {
        return state
      }
      if (state.preparing) {
        return state
      }
      return { ...state, preparing: true, result: null, changeSet: null, error: null }
    }
  }
}
