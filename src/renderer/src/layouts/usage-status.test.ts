import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Usage popover removal guard: the floating AppChrome dropdown is
 * gone for good. Clicking Usage toggles the docked right-side
 * UsageSidebar (see usage-sidebar.test.ts). This file fails if the
 * popover implementation ever returns.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('usage popover removal', () => {
  it('no floating usage menu remains in AppChrome', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(!chrome.includes('UsageStatusMenu'), 'UsageStatusMenu must not return')
    assert.ok(!chrome.includes('app-chrome__usage'), 'popover styling hooks must not return')
    assert.ok(!chrome.includes('usageAnchor'), 'popover anchor state must not return')
  })
})
