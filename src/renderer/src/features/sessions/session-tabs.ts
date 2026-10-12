import type { ChatAttachment } from '../../../../shared/chat-attachments/types'
import type { AgentTarget, StarkEffort } from '../../../../shared/agent-target/types'
import type { ProposalMode } from './proposal-state'

/**
 * Multi-session tab bookkeeping (pure, no React imports) so open-tab
 * list rules, close selection, draft stash scoping, and the tab cap
 * are unit-testable with the Node runner.
 *
 * Concepts (deliberately separate):
 * - persisted session: lives in session storage, survives restart,
 *   listed in history. Never created or deleted by tab operations.
 * - open tab: one id in the renderer-local open list. Presentation only.
 * - active tab: the single selected session rendered by SessionPanel.
 *
 * Tabs never fetch, poll, or mount background trees; switching only
 * changes the selection (messages reload through the existing
 * selection effect) while unsent drafts ride in the stash map.
 */

/** Hard cap: the tab strip is presentation state, never unbounded. */
export const MAX_OPEN_SESSION_TABS = 12

/**
 * Calm renderer notice shown when the tab cap blocks an open. Normal
 * tab-limit UI is not an exception condition — callers display this
 * as a status notice and leave tabs, selection, and drafts untouched.
 */
export const TAB_LIMIT_NOTICE = 'Too many sessions are open. Close a tab before opening another.'

/** Outcome of an attempt to open a session tab (no eviction involved). */
export type OpenSessionTabResult = 'opened' | 'already_open' | 'limit_reached'

/** Renderer-local unsent draft carried per open session (never in the DB). */
export interface SessionTabDraft {
  readonly composer: string
  readonly attachments: readonly ChatAttachment[]
  readonly mode: ProposalMode
  /**
   * Composer agent target + STARK effort stashed per session
   * (renderer memory only — never web storage, never the DB, so no
   * migration). Absent means the STARK/Regular defaults.
   */
  readonly target?: AgentTarget
  readonly effort?: StarkEffort
}

/** Fresh (empty) draft for a session with no stashed state. */
export function emptySessionTabDraft(mode: ProposalMode): SessionTabDraft {
  return { composer: '', attachments: [], mode }
}

/**
 * Attempts to ensure a session has an open tab. Never evicts: when the
 * strip is already at the cap and the session is not open, the list is
 * returned unchanged with `limit_reached` so the caller can show the
 * calm limit notice instead. Never touches drafts or attachments —
 * explicit close after the dirty-draft confirmation is the only path
 * that may discard draft state.
 */
export function openSessionTab(
  openIds: readonly number[],
  sessionId: number,
  _activeId: number | null,
  max: number = MAX_OPEN_SESSION_TABS
): { readonly openIds: readonly number[]; readonly result: OpenSessionTabResult } {
  if (openIds.includes(sessionId)) {
    return { openIds: [...openIds], result: 'already_open' }
  }
  if (openIds.length >= max) {
    return { openIds: [...openIds], result: 'limit_reached' }
  }
  return { openIds: [...openIds, sessionId], result: 'opened' }
}

/**
 * Removes one tab and picks the next active session deterministically:
 * the tab immediately to the left, else the first remaining tab, else
 * null when nothing remains (caller opens a fresh session then).
 * Closing an unknown id leaves the list untouched and keeps the
 * current active selection.
 */
export function closeSessionTab(
  openIds: readonly number[],
  closingId: number,
  activeId: number | null
): { readonly openIds: number[]; readonly nextActiveId: number | null } {
  const at = openIds.indexOf(closingId)
  if (at === -1) {
    return { openIds: [...openIds], nextActiveId: activeId }
  }
  const next = openIds.filter((id) => id !== closingId)
  if (next.length === 0) {
    return { openIds: next, nextActiveId: null }
  }
  if (at <= 0) {
    return { openIds: next, nextActiveId: next[0] ?? null }
  }
  return { openIds: next, nextActiveId: next[Math.min(at - 1, next.length - 1)] ?? null }
}

/** Stashes one session's unsent draft (replaces any previous stash). */
export function stashSessionDraft(
  drafts: Readonly<Record<number, SessionTabDraft>>,
  sessionId: number,
  draft: SessionTabDraft
): Readonly<Record<number, SessionTabDraft>> {
  return { ...drafts, [sessionId]: draft }
}

/** Drops one session's stash (close path; live state is restored separately). */
export function discardSessionDraft(
  drafts: Readonly<Record<number, SessionTabDraft>>,
  sessionId: number
): Readonly<Record<number, SessionTabDraft>> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [sessionId]: _dropped, ...rest } = drafts
  return rest
}

/** Close-guard input: unsent text or staged draft attachments. */
export function isSessionTabDirty(draft: SessionTabDraft | null): boolean {
  if (draft === null) {
    return false
  }
  return draft.composer.trim().length > 0 || draft.attachments.length > 0
}
