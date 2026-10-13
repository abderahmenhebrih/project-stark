import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ChatAttachment } from '../../../../shared/chat-attachments/types'
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

/**
 * Tab-cap safety: open tabs are presentation-only and NEVER evicted.
 * At 12 open tabs the 13th open is refused with `limit_reached`,
 * every existing tab/draft/attachment survives, and only an explicit
 * × (after the dirty-draft confirmation) may discard draft state.
 * Pure list/draft rules here; SessionPanel wiring is pinned by the
 * static guards below (same pattern as session-multitab.test.ts).
 */

function attachment(id: string): ChatAttachment {
  return { id, name: `${id}.png`, mimeType: 'image/png', size: 12, kind: 'image' }
}

function readSource(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('open session tabs (no eviction)', () => {
  it('appends new ids and never duplicates', () => {
    assert.deepEqual(openSessionTab([], 1, null), { openIds: [1], result: 'opened' })
    assert.deepEqual(openSessionTab([1, 2], 3, 1), { openIds: [1, 2, 3], result: 'opened' })
    assert.deepEqual(openSessionTab([1, 2], 2, 1), { openIds: [1, 2], result: 'already_open' })
    assert.deepEqual(openSessionTab([2, 1], 1, 2), { openIds: [2, 1], result: 'already_open' })
  })

  it('tabs 1–12 open; tab 13 returns limit_reached with every tab preserved', () => {
    assert.equal(MAX_OPEN_SESSION_TABS, 12)
    let open: readonly number[] = []
    for (let id = 1; id <= MAX_OPEN_SESSION_TABS; id += 1) {
      const next = openSessionTab(open, id, 1)
      assert.equal(next.result, 'opened')
      open = next.openIds
    }
    assert.deepEqual(open, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const activeId = 5
    const blocked = openSessionTab(open, 13, activeId)
    assert.equal(blocked.result, 'limit_reached')
    // No existing tab disappears (clean inactive tabs included).
    assert.deepEqual(blocked.openIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    // Active tab unchanged: the helper never reselects.
    assert.equal(activeId, 5)
    assert.ok(blocked.openIds.includes(activeId), 'active tab must survive a capped open')
  })

  it('already-open sessions activate even at the cap (no duplicate, no refusal)', () => {
    const full = Array.from({ length: MAX_OPEN_SESSION_TABS }, (_, index) => index + 1)
    for (const id of full) {
      const next = openSessionTab(full, id, 1)
      assert.equal(next.result, 'already_open')
      assert.deepEqual(next.openIds, full)
    }
  })

  it('limit results are deterministic across repeated attempts', () => {
    const full = Array.from({ length: MAX_OPEN_SESSION_TABS }, (_, index) => index + 1)
    assert.deepEqual(openSessionTab(full, 99, 5), openSessionTab(full, 99, 5))
    assert.equal(openSessionTab(full, 99, 5).result, 'limit_reached')
  })

  it('closing one tab permits another to open', () => {
    const full = Array.from({ length: MAX_OPEN_SESSION_TABS }, (_, index) => index + 1)
    const closed = closeSessionTab(full, 3, 5)
    assert.equal(closed.openIds.length, MAX_OPEN_SESSION_TABS - 1)
    assert.ok(!closed.openIds.includes(3))
    const reopened = openSessionTab(closed.openIds, 99, closed.nextActiveId)
    assert.equal(reopened.result, 'opened')
    assert.ok(reopened.openIds.includes(99))
    assert.equal(reopened.openIds.length, MAX_OPEN_SESSION_TABS)
  })

  it('limit notice copy stays calm and names the remedy', () => {
    assert.equal(TAB_LIMIT_NOTICE, 'Too many sessions are open. Close a tab before opening another.')
  })
})

describe('cap operations never touch drafts', () => {
  it('dirty inactive drafts and staged attachment ids survive a capped open', () => {
    const full = Array.from({ length: MAX_OPEN_SESSION_TABS }, (_, index) => index + 1)
    let drafts: Readonly<Record<number, SessionTabDraft>> = {}
    for (const id of full) {
      drafts = stashSessionDraft(
        drafts,
        id,
        id === 2
          ? { composer: 'unsent work in an inactive tab', attachments: [attachment('draft-a')], mode: 'work' as const }
          : emptySessionTabDraft('ask')
      )
    }
    const blocked = openSessionTab(full, 99, 1)
    assert.equal(blocked.result, 'limit_reached')
    // The cap path returns no victim set: the caller has nothing to
    // discard and no attachment cleanup to run.
    assert.deepEqual(blocked.openIds, full)
    const survivor = drafts[2]
    assert.ok(survivor !== undefined, 'inactive draft must survive a capped open')
    assert.equal(isSessionTabDirty(survivor), true)
    assert.deepEqual(
      survivor.attachments.map((entry) => entry.id),
      ['draft-a']
    )
    assert.deepEqual(drafts[7], emptySessionTabDraft('ask'))
  })

  it('no cap operation calls removeChatAttachmentDraft (only explicit × may)', () => {
    const panel = readSource('features/sessions/SessionPanel.tsx')
    const handleNewAt = panel.indexOf('async function handleNew()')
    assert.ok(handleNewAt >= 0, '+ creation path must exist')
    const handleNewEnd = panel.indexOf('function handleSelect(sessionId: number)', handleNewAt)
    const handleNewBody = panel.slice(handleNewAt, handleNewEnd)
    assert.ok(!handleNewBody.includes('removeChatAttachmentDraft'), '+ must never release draft assets')
    const syncAt = panel.indexOf('const next = openSessionTab(openSessionIds, selectedSessionId, prev)')
    assert.ok(syncAt >= 0, 'open-tab sync must use the bounded helper')
    const syncRegion = panel.slice(Math.max(0, syncAt - 200), syncAt + 900)
    assert.ok(!syncRegion.includes('removeChatAttachmentDraft'), 'cap sync must never release draft assets')
    assert.ok(syncRegion.includes('limit_reached'), 'cap sync must branch on the limit result')
  })
})

describe('+ at cap creates zero backend sessions', () => {
  it('cap guard runs before createCodingSession without touching selection or drafts', () => {
    const panel = readSource('features/sessions/SessionPanel.tsx')
    const handleNewAt = panel.indexOf('async function handleNew()')
    assert.ok(handleNewAt >= 0, '+ creation path must exist')
    const handleNewEnd = panel.indexOf('function handleSelect(sessionId: number)', handleNewAt)
    const body = panel.slice(handleNewAt, handleNewEnd)
    const guardAt = body.indexOf('openSessionIds.length >= MAX_OPEN_SESSION_TABS')
    const createAt = body.indexOf('createCodingSession(workspaceId)')
    assert.ok(guardAt >= 0, '+ must check the tab cap')
    assert.ok(createAt >= 0, '+ must still create below the cap')
    assert.ok(guardAt < createAt, 'cap check must run BEFORE backend session creation')
    const guardRegion = body.slice(guardAt, createAt)
    assert.ok(guardRegion.includes('setTabLimitNotice(TAB_LIMIT_NOTICE)'), 'capped + must show the calm limit notice')
    assert.ok(!guardRegion.includes('dispatch('), 'capped + must not change selection')
    assert.ok(!guardRegion.includes('setTabDrafts'), 'capped + must not alter drafts')
    assert.ok(!guardRegion.includes('removeChatAttachmentDraft'), 'capped + must not clean attachments')
  })
})

describe('history behavior at cap', () => {
  it('already-open entries activate at cap; unopened entries are rejected untouched', () => {
    const panel = readSource('features/sessions/SessionPanel.tsx')
    const selectAt = panel.indexOf('function handleSelect(sessionId: number)')
    assert.ok(selectAt >= 0, 'history selection path must exist')
    const selectEnd = panel.indexOf('function handleCloseRequest()', selectAt)
    const body = panel.slice(selectAt, selectEnd)
    // Already open → falls through to dispatch (activates even at cap).
    assert.ok(body.includes('openSessionIds.includes(sessionId)'), 'history must know already-open sessions')
    assert.ok(body.includes("dispatch({ type: 'session-selected', workspaceId, sessionId })"), 'already-open history entries must activate')
    // Not open + at cap → notice and return before any dispatch.
    const guardAt = body.indexOf('openSessionIds.length >= MAX_OPEN_SESSION_TABS')
    const dispatchAt = body.indexOf("dispatch({ type: 'session-selected', workspaceId, sessionId })")
    assert.ok(guardAt >= 0 && dispatchAt >= 0 && guardAt < dispatchAt, 'cap guard must precede selection dispatch')
    const guardRegion = body.slice(guardAt, dispatchAt)
    assert.ok(guardRegion.includes('setTabLimitNotice(TAB_LIMIT_NOTICE)'), 'rejected history entry must show the same notice')
    assert.ok(!guardRegion.includes('createCodingSession'), 'history must never create backend sessions')
  })
})

describe('close session tabs', () => {
  it('removes the tab and prefers the left neighbor', () => {
    assert.deepEqual(closeSessionTab([1, 2, 3], 2, 2), { openIds: [1, 3], nextActiveId: 1 })
    assert.deepEqual(closeSessionTab([1, 2, 3], 3, 3), { openIds: [1, 2], nextActiveId: 2 })
  })

  it('falls back to the first remaining tab when closing the leftmost', () => {
    assert.deepEqual(closeSessionTab([1, 2, 3], 1, 1), { openIds: [2, 3], nextActiveId: 2 })
  })

  it('closing an inactive tab keeps the active selection', () => {
    assert.deepEqual(closeSessionTab([1, 2, 3], 1, 3), { openIds: [2, 3], nextActiveId: 2 })
    assert.deepEqual(closeSessionTab([1, 2, 3], 3, 1), { openIds: [1, 2], nextActiveId: 2 })
  })

  it('closing the final tab yields null so the caller opens a fresh session', () => {
    assert.deepEqual(closeSessionTab([7], 7, 7), { openIds: [], nextActiveId: null })
  })

  it('closing an unknown id leaves everything untouched', () => {
    assert.deepEqual(closeSessionTab([1, 2], 9, 1), { openIds: [1, 2], nextActiveId: 1 })
  })
})

describe('per-session draft stash', () => {
  it('stashes, reads back, and drops one session without touching others', () => {
    const draft = { composer: 'hello', attachments: [attachment('a')], mode: 'work' as const }
    let drafts = stashSessionDraft({}, 1, draft)
    drafts = stashSessionDraft(drafts, 2, emptySessionTabDraft('ask'))
    assert.deepEqual(drafts[1], draft)
    assert.deepEqual(drafts[2], emptySessionTabDraft('ask'))
    drafts = discardSessionDraft(drafts, 1)
    assert.equal(drafts[1], undefined)
    assert.deepEqual(drafts[2], emptySessionTabDraft('ask'))
  })

  it('restashing replaces the previous draft for that session only', () => {
    const first = { composer: 'one', attachments: [], mode: 'ask' as const }
    const second = { composer: 'two', attachments: [attachment('b')], mode: 'propose' as const }
    let drafts = stashSessionDraft({}, 1, first)
    drafts = stashSessionDraft(drafts, 1, second)
    assert.deepEqual(drafts[1], second)
  })

  it('dirty means unsent text or staged attachments (attachments stay scoped)', () => {
    assert.equal(isSessionTabDirty(null), false)
    assert.equal(isSessionTabDirty(emptySessionTabDraft('ask')), false)
    assert.equal(isSessionTabDirty({ composer: '   ', attachments: [], mode: 'ask' }), false)
    assert.equal(isSessionTabDirty({ composer: 'hi', attachments: [], mode: 'ask' }), true)
    assert.equal(
      isSessionTabDirty({ composer: '', attachments: [attachment('a')], mode: 'ask' }),
      true
    )
  })
})

describe('tab-cap schema marker', () => {
  it('schema remains v20 with no migration 020', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('020-looplink-audit.ts'), 'migration 020 must exist (schema v20)')
    assert.ok(!files.some((file) => file.startsWith('021')), 'no migration 020 may appear')
  })
})
