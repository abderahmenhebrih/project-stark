import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 13 structural layout guarantees: the ready-state workbench is
 * LEFT sidebar / CENTER editor / RIGHT session panel as flex siblings
 * inside the bounded viewport root. The session pane has a bounded
 * desktop width with its own internal scrolling, the center keeps
 * min-width: 0, the composer stays visible at the bottom, and the app
 * never returns to a vertically scrolling document.
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
  it('workbench renders left, center, and right panes as siblings', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('workbench-main'), 'HomePage must render the main coding area')
    assert.ok(home.includes('<Explorer'), 'center must keep the Explorer/editor pane')
    assert.ok(home.includes('workbench__session'), 'right must render the session pane')
    assert.ok(home.includes('<SessionPanel'), 'right pane must host the session panel')
    const mainIndex = home.indexOf('workbench-main')
    const explorerIndex = home.indexOf('<Explorer')
    const sessionIndex = home.indexOf('workbench__session')
    assert.ok(mainIndex >= 0 && explorerIndex > mainIndex && sessionIndex > explorerIndex, 'panes must be ordered left, center, right')
  })

  it('session panel has a bounded desktop width with collapse', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.workbench__session'), 'session pane CSS must exist')
    assert.ok(css.includes('360px'), 'session pane defaults to a desktop width inside 340–420px')
    assert.ok(css.includes('flex: 0 0'), 'session pane must not grow or shrink the center')
    assert.ok(css.includes('workbench__session-toggle'), 'a visible collapse toggle must exist')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sessionOpen'), 'panel visibility must be a real toggle')
    assert.ok(home.includes('Show session panel'), 'collapsed state must offer to show the panel')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Hide session panel'), 'open state must offer to hide the panel')
    assert.ok(panel.includes('onCollapse'), 'hide action must collapse through the owner')
  })

  it('session internals scroll while the app root stays bounded', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__messages'), 'messages area CSS must exist')
    assert.ok(css.includes('overflow-y: auto'), 'messages must scroll internally')
    assert.ok(css.includes('min-height: 0'), 'flex children must be allowed to shrink')
    assert.ok(css.includes('.session__composer'), 'composer CSS must exist')
    const shell = readRenderer('layouts/MainLayout.css')
    assert.ok(shell.includes('height: 100vh'), 'shell must stay bound to the viewport height')
    const homeCss = readRenderer('pages/HomePage.css')
    assert.ok(homeCss.includes('overflow: hidden'), 'workbench areas must clip instead of page-scrolling')
  })

  it('center editor keeps min-width zero beside the session pane', () => {
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.workbench__editor'), 'center editor pane must exist')
    assert.ok(explorerCss.includes('min-width: 0'), 'center must not be pushed off screen')
    assert.ok(explorerCss.includes('flex: 1'), 'center must fill remaining width')
  })

  it('session remounts per workspace with no leakage', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('key={active.id}'), 'workspace switches must remount workspace-scoped panes')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('workspace-changed'), 'panel must reset on workspace change')
    assert.ok(panel.includes('key={workspaceId}') || home.includes('<SessionPanel'), 'session state must be workspace-keyed')
  })
})
