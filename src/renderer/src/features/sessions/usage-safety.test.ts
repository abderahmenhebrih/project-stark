import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('usage renderer safety', () => {
  it('usage editor left Settings V2 while the architecture stays intact', () => {
    // Locked decision: Heart/Recovery/Usage have no Settings V2 nav
    // home. The editor UI is gone; the state shapes, APIs, and
    // runtime flows remain for the future AI integration pass.
    for (const file of [
      'features/settings/SettingsPage.tsx',
      'features/settings/sections/ModelsSettings.tsx',
      'features/settings/sections/PermissionsSettings.tsx',
      'features/settings/sections/AccountSettings.tsx',
      'features/settings/sections/BillingSettings.tsx',
      'features/settings/sections/AboutSettings.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('Save usage routing'), `${file} must not host the usage editor`)
      assert.ok(!source.includes('Refresh usage'), `${file} must not host the usage editor`)
    }
    const state = readRenderer('features/sessions/usage-state.ts')
    for (const action of ['routing-toggled', 'limit-added', 'alternate-edited', 'save-started']) {
      assert.ok(state.includes(action), `usage architecture must keep the ${action} action`)
    }
    for (const forbidden of [
      'remaining provider quota',
      'exact provider quota',
      'billing balance',
      'guaranteed quota'
    ]) {
      assert.ok(!state.includes(forbidden), `usage architecture must not claim ${forbidden}`)
    }
  })

  it('explains threshold routing honestly with explicit save only', () => {
    const state = readRenderer('features/sessions/usage-state.ts')
    assert.ok(state.includes('save-started'), 'usage architecture must keep explicit save actions')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Threshold route:'), 'runtime threshold decisions must stay visible in-session')
    assert.ok(!panel.includes('provider rejected'))
    assert.ok(!panel.includes('quota exceeded'))
  })

  it('has no polling, fetch, monetary, or credential surface', () => {
    // usage-state and usage-api are new usage-only modules: no timers,
    // no network, no credentials anywhere in them. (SessionPanel
    // legitimately manages the provider API key elsewhere; the usage
    // section itself adds no credential handling — covered below.)
    for (const file of ['features/sessions/usage-state.ts', 'lib/usage-api.ts']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('setInterval'), `${file} must not poll`)
      assert.ok(!source.includes('fetch('), `${file} must not fetch`)
      assert.ok(!source.includes('apiKey'), `${file} must not touch credentials`)
      assert.ok(!source.includes('credential'), `${file} must not touch credentials`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('setInterval'), 'SessionPanel must not poll')
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
  })

  it('shows threshold route decisions without implying provider rejection', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Threshold route:'))
    assert.ok(panel.includes('Local call threshold reached'))
    assert.ok(panel.includes('Local threshold reached; normal Heart route used because no alternate is configured.'))
    assert.ok(!panel.includes('provider rejected'))
    assert.ok(!panel.includes('quota exceeded'))
  })
})
