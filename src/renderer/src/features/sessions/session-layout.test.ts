import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 13/31 structural layout guarantees: the ready-state shell is
 * one global bar above a work area of activity rail + contextual
 * sidebar + primary canvas (AI conversation or editor tabs) with a
 * docked terminal drawer and a thin status strip. The conversation is
 * a primary surface (never a fixed ~300px side pane), secondary panes
 * are user-collapsible, and the app never returns to a vertically
 * scrolling document.
 * Runs against repository source (cwd is the repo root via npm).
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('stage 13 session layout', () => {
  it('shell renders one global bar above rail, sidebar, and canvas', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<AppChrome'), 'shell must render one global bar')
    assert.ok(home.includes('<Explorer'), 'shell must render the workspace explorer')
    assert.ok(home.includes('stage-shell'), 'shell root must bound the viewport')
    assert.ok(home.includes('stage-workarea'), 'shell must define the work area row')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('<StarkMark'), 'global bar must carry the STARK identity')
    assert.ok(chrome.includes('workspaceName'), 'global bar must carry the workspace identity')
    assert.ok(chrome.includes('onToggleSidebar'), 'sidebar visibility must be user-controlled')
    assert.ok(chrome.includes('onToggleTerminal'), 'terminal visibility must be user-controlled')
  })

  it('activity rail selects one contextual sidebar', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const activity of ['explorer', 'search', 'changes', 'git']) {
      assert.ok(rail.includes(activity), `rail must offer the ${activity} activity`)
    }
    assert.ok(rail.includes('aria-selected'), 'rail must expose the selected activity')
    assert.ok(rail.includes('onSelect'), 'rail selection must drive the sidebar')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<ActivityRail'), 'workbench must render the rail')
    assert.ok(explorer.includes('activity={activity}'), 'rail must reflect the controlled activity')
    assert.ok(explorer.includes('sidebarOpen'), 'sidebar must be collapsible, never permanently squeezed')
  })

  it('session conversation receives the primary canvas width', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('primary-canvas'), 'workbench must render a primary canvas surface')
    assert.ok(explorer.includes('canvas-tabs'), 'canvas must switch Session and Editor views')
    assert.ok(explorer.includes('sessionNode'), 'conversation must mount as a primary canvas view')
    assert.ok(explorer.includes("canvasView !== 'session'"), 'canvas views must be exclusive')
    assert.ok(!explorer.includes('workbench__session'), 'conversation must not live in a fixed side pane')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes("canvasView"), 'canvas view must be renderer-local state')
    assert.ok(home.includes('<SessionPanel'), 'canvas must host the session workspace')
  })

  it('session internals scroll while the app root stays bounded', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__messages'), 'messages area CSS must exist')
    assert.ok(css.includes('overflow-y: auto'), 'messages must scroll internally')
    assert.ok(css.includes('min-height: 0'), 'flex children must be allowed to shrink')
    assert.ok(css.includes('.session__composer'), 'composer CSS must exist')
    const shell = readRenderer('layouts/MainLayout.css')
    assert.ok(shell.includes('height: 100vh'), 'shell must stay bound to the viewport height')
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.primary-canvas'), 'canvas surface CSS must exist')
    assert.ok(explorerCss.includes('minmax(0, 1fr)'), 'canvas must flex instead of page-scrolling')
  })

  it('context section collapses without losing functionality', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('contextOpen'), 'attached context must be collapsible')
    assert.ok(panel.includes('aria-expanded={contextOpen}'), 'collapse state must be exposed')
    assert.ok(panel.includes('Attached context'), 'context drawer must keep its identity')
    assert.ok(panel.includes('Add note'), 'manual notes must stay reachable')
  })

  it('terminal drawer collapses to a handle without reserving height', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('bottom-drawer'), 'terminal must live in a docked drawer')
    assert.ok(explorer.includes('bottom-drawer__handle'), 'closed drawer must render a minimal handle')
    assert.ok(explorer.includes('<TerminalPanel'), 'open drawer must host the terminal')
    assert.ok(explorer.includes('terminalOpen'), 'drawer visibility must be user-controlled')
  })

  it('center editor keeps min-width zero beside canvas siblings', () => {
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.workbench__editor'), 'center editor pane must exist')
    assert.ok(explorerCss.includes('min-width: 0'), 'center must not be pushed off screen')
    assert.ok(explorerCss.includes('.canvas-view'), 'canvas views must own the flex sizing context')
  })

  it('session remounts per workspace with no leakage', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('key={active.id}'), 'workspace switches must remount workspace-scoped panes')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('workspace-changed'), 'panel must reset on workspace change')
  })
})
