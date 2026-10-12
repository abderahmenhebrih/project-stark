import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Usage Status guarantees: real mirrored data only, compact popover,
 * no navigation away from the work. Anything unknown renders as
 * unavailable — never invented quotas, costs, or token counts.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('usage status surface', () => {
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

  it('opens a compact anchored popover without navigating away', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('UsageStatusMenu'), 'Usage popover must exist')
    assert.ok(chrome.includes('role="dialog"'), 'popover must expose a dialog role')
    assert.ok(chrome.includes('aria-label="Usage status"'), 'dialog must be labelled')
    assert.ok(chrome.includes('createPortal'), 'popover must portal above chrome clipping')
    // The popover region itself must not navigate: usage data arrives
    // via mirrored props (the shell Settings button owns navigation).
    const menuStart = chrome.indexOf('function UsageStatusMenu')
    const menuEnd = chrome.indexOf('Single desktop chrome row', menuStart)
    const menu = menuEnd === -1 ? chrome.slice(menuStart) : chrome.slice(menuStart, menuEnd)
    assert.ok(!menu.includes('onOpenSettings'), 'usage popover must not reroute through Settings navigation')
    assert.ok(!menu.includes('settingsHost'), 'usage popover must not mount the Settings surface')
  })

  it('reads only real mirrored state (plan/target/effort/provider/model/summary)', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    for (const prop of ['planLabel', 'agentTarget', 'effort', 'providerConfigured', 'providerModel', 'usageSummary']) {
      assert.ok(chrome.includes(prop), `popover must read mirrored ${prop}`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('providerConfigured: provider.configured'), 'provider truth must mirror the real provider state')
    assert.ok(panel.includes('usageSummary: usage.summary'), 'usage must mirror the real ledger summary')
    assert.ok(panel.includes('planLabel: sponsorProductEntitlements.planLabel'), 'plan must mirror real entitlements')
  })

  it('marks unknown metrics unavailable and fabricates nothing', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('Not reported'), 'unknown counts must say Not reported')
    assert.ok(chrome.includes('Not tracked yet'), 'untracked cost/attachments must say Not tracked yet')
    assert.ok(chrome.includes('Not configured'), 'missing provider must say Not configured')
    for (const fabrication of ['quota', 'remaining', 'monthly limit', 'billing usage']) {
      assert.ok(!chrome.toLowerCase().includes(fabrication), `popover must not invent ${fabrication}`)
    }
  })

  it('exposes no secrets through the usage surface', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    const menu = chrome.slice(chrome.indexOf('function UsageStatusMenu'))
    for (const secret of ['apiKey', 'Authorization', 'Bearer', 'safeStorage']) {
      assert.ok(!menu.includes(secret), `usage popover must not touch ${secret}`)
    }
  })
})
