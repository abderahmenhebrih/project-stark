import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 session layout guarantees: the ready-state shell is one
 * global bar above a work area of primary session pane + contextual
 * secondary workspace pane (Review | Context | file with a stacked
 * terminal). The conversation is a primary surface that stays mounted
 * when the editor opens; the tools drawer overlays on demand and
 * consumes no permanent column; settings live in a dedicated surface.
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

describe('stage 31 session layout', () => {
  it('shell renders one global bar above the session workspace', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<AppChrome'), 'shell must render one global bar')
    assert.ok(home.includes('<Explorer'), 'shell must render the workspace explorer')
    assert.ok(home.includes('stage-shell'), 'shell root must bound the viewport')
    assert.ok(home.includes('stage-workarea'), 'shell must define the work area row')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('<StarkMark'), 'global bar must carry the STARK identity')
    assert.ok(chrome.includes('workspaceName'), 'global bar must carry the workspace identity')
    assert.ok(chrome.includes('onToggleSidebar'), 'drawer visibility must be user-controlled')
    assert.ok(!chrome.includes('onToggleTerminal'), 'terminal must not live in the top bar')
    assert.ok(!chrome.includes('name="terminal"'), 'terminal icon must not live in the top bar')
    assert.ok(chrome.includes('onOpenSearch'), 'workspace search must stay one click away')
    assert.ok(chrome.includes('onOpenSettings'), 'settings must stay one click away')
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    assert.ok(rail.includes('onToggleTerminal'), 'terminal visibility must be rail-controlled through the existing behavior')
  })

  it('workspace tools live in an overlay drawer, not a permanent column', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<WorkspaceToolsDrawer'), 'tools must render through the overlay drawer')
    assert.ok(explorer.includes('sidebarOpen'), 'drawer must be collapsible, never permanently squeezed')
    assert.ok(explorer.includes('onCloseSidebar'), 'drawer must be closable')
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(drawer.includes('activity'), 'drawer must host the activity selector')
    assert.ok(drawer.includes('Escape'), 'drawer must close on Escape')
    const css = readRenderer('features/explorer/Explorer.css')
    const block = css.match(/\.workspace-tools-drawer\s*\{[^}]*\}/)
    assert.ok(block !== null, 'drawer CSS must exist')
    assert.ok(block[0].includes('position: absolute'), 'drawer must overlay instead of consuming a column')
  })

  it('session conversation stays mounted as the primary pane', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('workspace__session'), 'workbench must render a primary session pane')
    assert.ok(explorer.includes('sessionNode'), 'conversation must mount as the primary pane')
    assert.ok(explorer.includes('<WorkspaceSecondaryPane'), 'review/context/files must open beside the session')
    assert.ok(!explorer.includes('workbench__session'), 'conversation must not live in a fixed side pane')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<SessionPanel'), 'shell must host the session workspace')
    assert.ok(home.includes('canvasView'), 'narrow widths must switch panes instead of squeezing')
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
    assert.ok(explorerCss.includes('.workspace__secondary'), 'secondary pane CSS must exist')
    assert.ok(explorerCss.includes('minmax(0, 1fr)') || explorerCss.includes('min-height: 0'), 'panes must flex instead of page-scrolling')
  })

  it('attached context lives in the secondary pane with composer chips', () => {
    const tab = readRenderer('features/sessions/ContextTab.tsx')
    assert.ok(tab.includes('Add note'), 'manual notes must stay reachable')
    assert.ok(tab.includes('No context attached'), 'empty-state guidance must stay reachable')
    assert.ok(tab.includes('draft-removed'), 'draft removal must stay reachable')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__context-chips'), 'composer must summarize attached context as chips')
    assert.ok(panel.includes('onOpenContext'), 'chips must open the Context tab')
    assert.ok(!panel.includes('aria-label="Attached context"'), 'no large context drawer may remain in the conversation flow')
  })

  it('terminal stacks in the secondary region without reserving global height', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<TerminalPanel'), 'open stack must host the terminal')
    assert.ok(explorer.includes('terminalOpen'), 'stack visibility must be user-controlled')
    assert.ok(explorer.includes('aria-label="Hide terminal"'), 'stack state must be exposed')
    assert.ok(!explorer.includes('bottom-drawer'), 'the global full-width bottom drawer must be retired')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes('workspace__terminal'), 'terminal must stack inside the secondary region')
    assert.ok(pane.includes('terminalOpen &&'), 'closed terminal must reserve no area')
  })

  it('settings leave the message timeline for a dedicated surface', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('<StarkSettingsSurface'), 'settings must render in the dedicated surface')
    assert.ok(panel.includes('settingsOpen'), 'surface visibility must stay renderer-local')
    assert.ok(!panel.includes('aria-label="AI settings"'), 'no giant settings form may remain inline in the timeline')
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(surface.includes('<AccountSection'), 'AccountSection must be mounted in Settings')
    assert.ok(surface.includes('role="dialog"'), 'settings must present as a dedicated surface')
  })

  it('session remounts per workspace with no leakage', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('key={active.id}'), 'workspace switches must remount workspace-scoped panes')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('workspace-changed'), 'panel must reset on workspace change')
  })
})
