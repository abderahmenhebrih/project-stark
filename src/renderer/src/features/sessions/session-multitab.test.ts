import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Multi-session tab bar guarantees: several persisted sessions stay
 * open as chrome tabs with exactly one active; + creates, history
 * reopens, × closes presentation only, and per-session unsent drafts
 * survive switching. Tabs never create/delete sessions, never poll,
 * and never mount background trees. Runs against repository source
 * (cwd is the repo root via npm).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function panelCloseRegion(): string {
  const panel = readRenderer('features/sessions/SessionPanel.tsx')
  const start = panel.indexOf('function requestCloseTab')
  const end = panel.indexOf('function handleLoadOlder', start)
  assert.ok(start >= 0 && end > start, 'tab close flow must exist')
  return panel.slice(start, end)
}

describe('open tabs state and creation', () => {
  it('+ creates exactly one session and opens exactly one tab', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('createCodingSession(workspaceId)'), '+ must create through the existing session system')
    assert.ok(panel.includes('creatingRef.current'), 'rapid clicks must keep the single-flight guard')
    const creation = panel.slice(panel.indexOf('async function handleNew()'), panel.indexOf('async function handleNew()') + 1400)
    assert.ok(creation.includes("dispatch({ type: 'session-created', session })"), 'creation must select the new session')
    assert.ok(panel.includes('openSessionTab(openSessionIds, selectedSessionId, prev)'), 'selection must ensure one open tab')
    const tabs = readRenderer('features/sessions/session-tabs.ts')
    assert.ok(tabs.includes('MAX_OPEN_SESSION_TABS = 12'), 'open-tab count must be bounded')
  })

  it('several tabs coexist with exactly one selected', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('openSessionIds.map((sessionId)'), 'strip must render every open tab')
    assert.ok(chrome.includes('aria-selected={active}'), 'exactly one tab must read selected (derived per tab)')
    assert.ok(chrome.includes('role="tablist"'), 'strip must stay a tab list')
    assert.ok(chrome.includes('onSelectSessionTab(sessionId)'), 'tab click must switch without recreation')
  })

  it('switching displays the session and creates nothing', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const selectAt = panel.indexOf('function handleSelect(sessionId: number)')
    assert.ok(selectAt >= 0, 'tab/history selection must exist')
    const selectBody = panel.slice(selectAt, selectAt + 900)
    assert.ok(selectBody.includes("dispatch({ type: 'session-selected'"), 'switch must change the selection')
    assert.ok(!selectBody.includes('createCodingSession'), 'switching must never create a session')
    assert.ok(panel.includes("dispatch({ type: 'messages-loading', workspaceId, sessionId, requestId })"), 'switch must reload that session’s messages')
    assert.ok(!panel.includes('setInterval'), 'switching must not poll')
  })

  it('history opens sessions as tabs without duplicates or new sessions', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('onSelectSession(entry.id)'), 'history must open the persisted session')
    assert.ok(chrome.includes('openSessionIds.includes(entry.id)'), 'history must know already-open sessions')
    assert.ok(chrome.includes('app-chrome__history-item--open'), 'open sessions must be marked subtly')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const selectAt = panel.indexOf('function handleSelect(sessionId: number)')
    const selectBody = panel.slice(selectAt, selectAt + 300)
    assert.ok(!selectBody.includes('createCodingSession'), 'history must never duplicate the database session')
  })
})

describe('tab close semantics', () => {
  it('per-tab × closes presentation only, never deletes', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('onCloseSessionTab(sessionId)'), 'each tab must carry its own close')
    assert.ok(chrome.includes('stopPropagation'), '× must not activate the tab underneath')
    assert.ok(chrome.includes('aria-label="Close session"'), '× must stay labelled')
    const region = panelCloseRegion()
    assert.ok(!region.includes('delete') && !region.includes('DELETE'), 'close must never delete')
    assert.ok(!region.includes('dropSession') && !region.includes('removeSession'), 'close must never remove persisted sessions')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('closeSessionTab: (sessionId: number) => requestCloseTab(sessionId)'), 'shell must forward per-tab close')
  })

  it('persisted session, messages, and committed attachments survive close', () => {
    const region = panelCloseRegion()
    assert.ok(!region.includes('sessions-loaded'), 'close must not rewrite the session list')
    assert.ok(!region.includes('messages-loaded'), 'close must not touch committed messages')
    assert.ok(region.includes('committed attachments'), 'close path must document committed rows are untouched')
    assert.ok(region.includes('removeChatAttachmentDraft'), 'close must release only uncommitted draft assets')
  })

  it('active close selects deterministically; final close opens a fresh session', () => {
    const region = panelCloseRegion()
    assert.ok(region.includes('closeSessionTab(openSessionIds, closingId'), 'close must use the deterministic helper')
    assert.ok(region.includes("dispatch({ type: 'session-selected', workspaceId, sessionId: nextActiveId })"), 'close must activate the neighbour tab')
    assert.ok(region.includes('await handleNew()'), 'final close must open a safe replacement session')
  })

  it('dirty tabs guard; Cancel preserves, Confirm cleans drafts only', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('closeTabIdRef'), 'pending close target must survive to confirmation')
    assert.ok(panel.includes('isSessionTabDirty(draft)'), 'guard must cover the closing tab’s own draft')
    assert.ok(panel.includes('Close this session?'), 'existing confirmation copy must stay')
    assert.ok(panel.includes('You have an unsent draft.'), 'confirmation must name the draft')
    const cancelAt = panel.indexOf('function handleCloseCancel()')
    const cancelBody = panel.slice(cancelAt, cancelAt + 200)
    assert.ok(!cancelBody.includes('dispatch'), 'Cancel must change nothing')
    const region = panelCloseRegion()
    assert.ok(region.includes('Promise.allSettled'), 'confirmed draft release must settle boundedly')
  })
})

describe('draft preservation across tabs', () => {
  it('switching stashes the live draft and restores the arriving one', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('stashSessionDraft(drafts, prev, stashed)'), 'leaving a tab must stash its draft')
    assert.ok(panel.includes('setComposer(incoming.composer)'), 'arriving must restore stashed text')
    assert.ok(panel.includes('setAttachments(incoming.attachments)'), 'arriving must restore stashed attachments')
    assert.ok(panel.includes("proposalDispatch({ type: 'mode-changed', workspaceId, mode: incoming.mode })"), 'arriving must restore the stashed mode')
    assert.ok(panel.includes('emptySessionTabDraft(proposal.mode)'), 'fresh tabs must start empty')
  })

  it('draft attachments stay scoped to their owning session', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('tabDrafts[sessionId]'), 'inactive drafts must resolve from the stash, not live state')
    assert.ok(panel.includes('discardSessionDraft(drafts, closingId)'), 'closed tabs must drop their stash')
  })

  it('chrome order keeps + and ... reachable beside the strip', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    const stripAt = chrome.indexOf('app-chrome__tabs')
    const plusAt = chrome.indexOf('app-chrome__newtab')
    const moreAt = chrome.indexOf('app-chrome__popover')
    const spacerAt = chrome.indexOf('app-chrome__spacer')
    const controlsAt = chrome.indexOf('app-chrome__controls')
    assert.ok(stripAt < plusAt && plusAt < moreAt && moreAt < spacerAt && spacerAt < controlsAt, 'strip, +, ..., space, and utilities must keep chrome order')
  })

  it('overflow scrolls inside the strip; the page never scrolls sideways', () => {
    const css = readRenderer('layouts/AppChrome.css')
    const strip = css.match(/\.app-chrome__tabs\s*\{[^}]*\}/)
    assert.ok(strip !== null, 'strip CSS must exist')
    assert.ok(strip[0].includes('overflow-x: auto'), 'excess tabs must scroll inside the strip')
    assert.ok(strip[0].includes('flex: 1 1 auto'), 'strip must take available width without pushing siblings')
    const tab = css.match(/\.app-chrome__tab\s*\{[^}]*\}/)
    assert.ok(tab !== null && tab[0].includes('min-width: 130px'), 'tabs must shrink to a compact minimum first')
    assert.ok(tab[0].includes('max-width: 320px'), 'tabs must stay bounded')
    assert.ok(tab[0].includes('min-height: 44px'), 'tabs must keep desktop height')
  })
})

describe('no backend, polling, or schema drift', () => {
  it('tabs add no timers, intervals, or background mounts', () => {
    for (const relative of ['features/sessions/SessionPanel.tsx', 'layouts/AppChrome.tsx', 'pages/HomePage.tsx']) {
      const source = readRenderer(relative)
      assert.ok(!source.includes('setInterval'), `${relative} must not poll`)
    }
    const tabs = readRenderer('features/sessions/session-tabs.ts')
    assert.ok(!tabs.includes('useEffect') && !tabs.includes('setInterval'), 'tab rules must stay pure')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('<SessionPanel'), 'only the active session may mount a panel tree')
  })

  it('restart and workspace behavior stay renderer-local with schema v19', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('useState<readonly number[]>([])'), 'open tabs must start empty per mount (no persisted tab set)')
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })

  it('shell snapshot carries the strip without new IPC', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('openSessionIds,'), 'chrome snapshot must carry open tabs')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('openSessionIds'), 'shell must forward the strip')
    assert.ok(home.includes('onCloseSessionTab={handleCloseSessionTab}'), 'shell must forward per-tab close')
    for (const forbidden of ['.invoke(', 'ipcRenderer']) {
      assert.ok(!readRenderer('layouts/AppChrome.tsx').includes(forbidden), `chrome must not contain ${forbidden}`)
    }
  })
})
