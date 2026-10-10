import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stabilization pass: terminal rail, session +/close, overflow menu.
 *
 * Static guarantees over renderer source (cwd is the repo root via
 * npm): the Terminal action lives on the activity rail below
 * Extensions (never in AppChrome); + reuses the existing session
 * creation as a single flight; the tab X closes presentation only
 * with an unsent-draft guard; the ... menu escapes chrome clipping
 * through a document.body portal. No new terminal IPC, no session
 * deletion, no polling, no retry loops.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

/** Source with line/block comments removed, so assertions test code — not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('stabilization: terminal rail', () => {
  it('rail order is Explorer/Search/Changes/Git/Extensions/Terminal', () => {
    const rail = codeOnly(readRenderer('features/explorer/ActivityRail.tsx'))
    // The five drawer views render in ACTIVITIES order via map; the
    // Terminal action button follows them in the same tablist.
    const kinds = ['explorer', 'search', 'changes', 'git', 'extensions'].map((kind) =>
      rail.indexOf(`kind: '${kind}'`)
    )
    for (const [position, found] of kinds.entries()) {
      assert.ok((found ?? -1) >= 0, `rail must declare the ${['explorer', 'search', 'changes', 'git', 'extensions'][position]} activity`)
    }
    for (let index = 1; index < kinds.length; index += 1) {
      assert.ok((kinds[index] ?? -1) > (kinds[index - 1] ?? -1), 'rail order must be Explorer/Search/Changes/Git/Extensions first')
    }
    assert.ok(!rail.includes("kind: 'terminal'"), 'Terminal must stay an action, not a drawer view')
    const terminalButton = rail.indexOf('name="terminal"')
    assert.ok(terminalButton > (kinds[4] ?? -1), 'Terminal must sit below Extensions')
    assert.ok(rail.includes('>Terminal</span>'), 'Terminal must carry the same visible label pattern')
  })

  it('rail Terminal reuses the existing toggle with active state and no new IPC', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    assert.ok(rail.includes('onToggleTerminal'), 'rail Terminal must invoke the existing terminal action')
    assert.ok(rail.includes('terminalOpen'), 'rail Terminal must reflect terminal visibility')
    assert.ok(rail.includes('aria-pressed'), 'rail Terminal must expose pressed state')
    assert.ok(rail.includes('name="terminal"'), 'rail must use the existing STARK terminal icon')
    for (const file of ['features/explorer/ActivityRail.tsx', 'layouts/WorkspaceToolsDrawer.tsx']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC (same manager, same terminal)`)
    }
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(drawer.includes('onToggleTerminal'), 'drawer must forward the existing toggle to the rail')
  })

  it('AppChrome carries no terminal affordance', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(!chrome.includes('onToggleTerminal'), 'AppChrome must not own terminal toggling')
    assert.ok(!chrome.includes('terminalOpen'), 'AppChrome must not track terminal visibility')
    assert.ok(!chrome.includes('name="terminal"'), 'AppChrome must not render the terminal icon')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('onToggleTerminal={handleToggleTerminal}'), 'shell must keep the single existing toggle for panes')
  })
})

describe('stabilization: session + creation', () => {
  it('+ invokes the existing session creation through the shell bridge', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('onClick={onNewSession}'), '+ must invoke the forwarded new-session action')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sessionActionsRef.current?.newSession()'), 'shell must forward to the panel action (no second implementation)')
    assert.ok(home.includes('onNewSession={handleNewSession}'), 'shell must wire + to the forwarder')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('createCodingSession(workspaceId)'), '+ must create through the existing session system')
    assert.ok(panel.includes("dispatch({ type: 'session-created', session })"), '+ must switch to the created session')
  })

  it('creation works provider-disconnected with exactly one flight', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    const creation = panel.slice(panel.indexOf('async function handleNew()'), panel.indexOf('async function handleNew()') + 1100)
    assert.ok(creation.includes('createCodingSession(workspaceId)'), 'creation must use the existing session call')
    assert.ok(!creation.includes('aiReady'), 'creation must not gate on AI readiness')
    assert.ok(!creation.includes('getProviderState'), 'creation must not consult provider state')
    assert.ok(!creation.includes('provider.'), 'creation must not require provider connectivity')
    assert.ok(creation.includes('creatingRef.current'), 'rapid clicks must be rejected synchronously (one creation at a time)')
    assert.ok(creation.includes('setCreatingSession(true)'), 'creation must mirror visible busy state')
    assert.ok(!panel.includes('setInterval') && !panel.includes('setTimeout'), 'no polling or retry timers around creation')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('disabled={sessionsLoading || creatingSession}'), '+ must disable while loading or creating')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('creatingSession'), 'shell snapshot must carry the creation flag')
  })
})

describe('stabilization: session tab close', () => {
  it('X renders compactly with label, tooltip, and propagation guard', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('app-chrome__tab-close'), 'X must sit in the session tab')
    assert.ok(chrome.indexOf('app-chrome__tab-close') > chrome.indexOf('app-chrome__tab-title'), 'X must sit at the far right of the tab')
    assert.ok(chrome.includes('aria-label="Close session"'), 'X must be labelled')
    assert.ok(chrome.includes('title="Close session"'), 'X must carry a tooltip')
    assert.ok(chrome.includes('stopPropagation'), 'X must not trigger tab selection underneath')
    const css = readRenderer('layouts/AppChrome.css')
    const close = css.match(/\.app-chrome__tab-close\s*\{[^}]*\}/)
    assert.ok(close !== null && close[0].includes('width: 22px'), 'X must stay compact')
    assert.ok(css.includes('.app-chrome__tab-close:hover'), 'X must give hover feedback')
    assert.ok(css.includes('.app-chrome__tab-close:focus-visible'), 'X must show a focus ring')
  })

  it('close never deletes: presentation-only transition with history intact', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('closeSession'), 'panel must expose the close action to the shell')
    const closeStart = panel.indexOf('async function performClose()')
    const closeEnd = panel.indexOf('async function handleSend()', closeStart)
    const closeRegion = closeEnd === -1 ? panel.slice(closeStart) : panel.slice(closeStart, closeEnd)
    assert.ok(closeRegion.includes("dispatch({ type: 'session-selected'"), 'close must transition to another recent session when one remains')
    assert.ok(closeRegion.includes('await handleNew()'), 'close must open a fresh local session when none remains')
    assert.ok(!closeRegion.includes('delete') && !closeRegion.includes('DELETE'), 'close must never delete')
    assert.ok(!closeRegion.includes('dropSession') && !closeRegion.includes('removeSession'), 'close must never remove persisted sessions')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sessionActionsRef.current?.closeSession()'), 'shell must forward close without a second implementation')
  })

  it('unsent drafts require confirmation and release only draft assets', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Close this session?'), 'close must confirm with existing confirmation copy')
    assert.ok(panel.includes('You have an unsent draft.'), 'close must name the unsent draft')
    assert.ok(panel.includes('Cancel'), 'confirmation must offer Cancel')
    assert.ok(panel.includes('isComposerEmpty(composer)'), 'composer text must guard the close')
    assert.ok(panel.includes('attachments.length === 0'), 'staged draft attachments must guard the close')
    assert.ok(panel.includes('removeChatAttachmentDraft'), 'confirmed close must release drafts through the narrow removeDraft API')
    assert.ok(panel.includes('Promise.allSettled'), 'draft release must settle boundedly without loops')
    assert.ok(panel.includes('committed attachments'), 'close path must document that committed rows are untouched')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__confirm'), 'confirmation must use existing session confirmation styling')
  })
})

describe('stabilization: overflow menu layering', () => {
  it('menu renders through a document.body portal above tabs, below modals', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('createPortal'), 'menu must render through a React portal')
    assert.ok(chrome.includes('document.body'), 'portal must attach to document.body (outside chrome clipping)')
    assert.ok(chrome.includes('getBoundingClientRect'), 'portal placement must derive from the ... button rect')
    const css = readRenderer('layouts/AppChrome.css')
    const portal = css.match(/\.app-chrome__menu--portal\s*\{[^}]*\}/)
    assert.ok(portal !== null, 'portal CSS must exist')
    assert.ok(portal[0].includes('position: fixed'), 'portal menu must use fixed positioning')
    assert.ok(portal[0].includes('z-index: 50'), 'menu layer must sit above tabs/drawer and below modal dialogs')
  })

  it('menu keeps behavior: Escape, outside click, viewport fit, unchanged actions', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes("event.key === 'Escape'"), 'menu must close on Escape')
    assert.ok(chrome.includes('pointerdown'), 'menu must close on outside click')
    assert.ok(chrome.includes('window.innerWidth') && chrome.includes('window.innerHeight'), 'menu must stay inside the viewport')
    assert.ok(chrome.includes('Continue with Looplink'), 'overflow actions must be preserved exactly')
    assert.ok(chrome.includes('Session history'), 'history list must be preserved exactly')
    assert.ok(chrome.includes('onSelectSession(entry.id)'), 'history selection must keep existing behavior')
  })
})
