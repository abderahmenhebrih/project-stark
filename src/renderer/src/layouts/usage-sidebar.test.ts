import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Docked Usage sidebar guarantees: real layout space at the right of
 * the workarea (OpenCode-style, STARK styling), real mirrored data
 * only, no floating popover. Anything unknown renders as
 * unavailable — never invented windows, costs, or token counts.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('docked usage sidebar', () => {
  it('sits in the AppChrome cluster after Settings with icon + tooltip', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    const controls = chrome.slice(chrome.indexOf('role="toolbar"'))
    const searchAt = controls.indexOf('aria-label="Search workspace"')
    const settingsAt = controls.indexOf('aria-label="Open settings"')
    const usageAt = controls.indexOf('aria-label="Usage status"')
    const liveAt = controls.indexOf('aria-label="Open Live Review"')
    assert.ok(searchAt >= 0 && settingsAt >= 0 && usageAt >= 0 && liveAt >= 0, 'Search, Settings, Usage, Live Review must all exist')
    assert.ok(searchAt < settingsAt && settingsAt < usageAt && usageAt < liveAt, 'order must be Search → Settings → Usage → Live Review')
    assert.ok(controls.includes('title="Usage status"'), 'Usage must tooltip')
    assert.ok(controls.includes('name="usage"'), 'Usage must use the professional icon')
  })

  it('toggles a docked sidebar instead of a popover', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(!chrome.includes('UsageStatusMenu'), 'the floating Usage popover must be gone')
    assert.ok(!chrome.includes('function UsageStatusMenu'), 'no popover implementation may remain')
    assert.ok(chrome.includes('onToggleUsage'), 'Usage must toggle through a shell-owned handler')
    assert.ok(chrome.includes('aria-expanded={usageOpen}'), 'toggle must expose its state')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<UsageSidebar'), 'shell must dock the sidebar')
    assert.ok(home.includes('usageSidebarOpen'), 'sidebar visibility must be shell-owned')
    const css = readRenderer('layouts/UsageSidebar.css')
    assert.ok(css.includes('.usage-sidebar'), 'sidebar must own its layout surface')
    assert.ok(/flex:\s*0\s*0\s*3\d\dpx|width:\s*3\d\dpx/.test(css), 'sidebar must occupy 300–330px of real layout space')
  })

  it('occupies layout space without remounting the session', () => {
    const home = readRenderer('pages/HomePage.tsx')
    const workarea = home.slice(home.indexOf('stage-workarea'))
    assert.ok(workarea.includes('<UsageSidebar'), 'sidebar must live inside the workarea row')
    // stage-workarea__main keeps display:contents (layout-transparent);
    // the sidebar is a plain flex sibling — no remount of Explorer/session.
    assert.ok(!workarea.includes('key={') || workarea.includes('key={active.id}'), 'no new remount keys around the session')
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(!sidebar.includes('useNavigate') && !sidebar.includes('navigate'), 'sidebar must not navigate')
  })

  it('headers with the real session name and creation time', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(sidebar.includes('sessionTitle'), 'header must show the session name')
    assert.ok(sidebar.includes('sessionCreatedAt'), 'header must show the creation timestamp')
    assert.ok(sidebar.includes('aria-label="Close usage sidebar"'), 'sidebar must offer its own close')
  })

  it('shows context, session usage, untracked cost, and model truth', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(sidebar.includes('Context'), 'context section must exist')
    assert.ok(sidebar.includes('latestInputTokens'), 'context must use actual latest provider input tokens')
    assert.ok(sidebar.includes('Limit not reported'), 'unknown context limits must say so')
    for (const row of ['Calls', 'Input tokens', 'Output tokens', 'Total tokens']) {
      assert.ok(sidebar.includes(row), `session usage must show ${row}`)
    }
    assert.ok(sidebar.includes('Not tracked'), 'unknown cost must say Not tracked')
    assert.ok(!sidebar.includes('$0.00'), 'zero cost must never render for unknown cost')
    for (const row of ['Agent', 'Provider', 'Model', 'Executed', 'Effort']) {
      assert.ok(sidebar.includes(row), `model block must show ${row}`)
    }
    assert.ok(sidebar.includes('Not reported'), 'unknown values must say Not reported')
    for (const fabrication of ['quota', 'remaining', 'monthly limit', 'billing usage']) {
      assert.ok(!sidebar.toLowerCase().includes(fabrication), `sidebar must not invent ${fabrication}`)
    }
  })

  it('shows the actual executor distinct from the requested selector', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(sidebar.includes('lastExecutorModel'), 'executor must come from the ledger summary')
    assert.ok(sidebar.includes('displayLabelForStableId'), 'executor ids must resolve through the model library')
    assert.ok(sidebar.includes('<dt>Executed</dt>'), 'executor must be its own row')
    // The requested Model row stays selector truth; Executed is executor truth.
    const modelAt = sidebar.indexOf('<dt>Model</dt>')
    const executedAt = sidebar.indexOf('<dt>Executed</dt>')
    assert.ok(modelAt >= 0 && executedAt > modelAt, 'Executed must follow the requested Model row')
    assert.ok(sidebar.includes("executorLabel ?? 'Not reported'"), 'unknown executor must say Not reported')
  })

  it('updates live from ledger state without polling', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    assert.ok(sidebar.includes('usageSummary'), 'session usage must reload when the ledger summary changes')
    assert.ok(!sidebar.includes('setInterval'), 'no polling may exist')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('refreshUsageSummary(workspaceId)'), 'settled AI calls must refresh the summary')
  })

  it('exposes no secrets through the usage surface', () => {
    const sidebar = readRenderer('layouts/UsageSidebar.tsx')
    for (const secret of ['apiKey', 'Authorization', 'Bearer', 'safeStorage']) {
      assert.ok(!sidebar.includes(secret), `usage sidebar must not touch ${secret}`)
    }
  })
})
