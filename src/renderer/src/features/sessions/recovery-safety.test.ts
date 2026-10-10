import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('recovery renderer safety', () => {
  it('no dangerouslySetInnerHTML or innerHTML in session panel', () => {
    const source = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!source.includes('dangerouslySetInnerHTML'))
    assert.ok(!source.includes('innerHTML'))
  })

  it('recovery settings have explicit save with no autosave or polling', () => {
    const state = readRenderer('features/sessions/recovery-state.ts')
    assert.ok(state.includes('save-started'), 'recovery architecture must keep explicit save actions')
    assert.ok(!state.includes('setInterval'))
    assert.ok(!state.includes('setTimeout'))
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('setInterval'))
    assert.ok(!panel.includes('setTimeout'))
  })

  it('recovery editor left Settings V2 while events and APIs stay intact', () => {
    // Locked decision: the recovery editor has no Settings V2 nav
    // home. The event flow (banners, handoffs, dismissals) and the
    // API layer stay fully functional.
    for (const file of [
      'features/settings/SettingsPage.tsx',
      'features/settings/sections/ModelsSettings.tsx',
      'features/settings/sections/PermissionsSettings.tsx',
      'features/settings/sections/AccountSettings.tsx',
      'features/settings/sections/BillingSettings.tsx',
      'features/settings/sections/AboutSettings.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('Save Recovery'), `${file} must not host the recovery editor`)
      assert.ok(!source.includes('Continuity Recovery'), `${file} must not host the recovery editor`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('event-loaded'), 'runtime recovery event flow must stay wired')
    assert.ok(panel.includes('getRecoveryForTarget'), 'recovery banners must keep loading')
    const api = readRenderer('lib/recovery-api.ts')
    assert.ok(!api.includes('apiKey'))
  })

  it('no proposal recovery UI exists', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const lower = panel.toLowerCase()
    assert.ok(!lower.includes('proposal recovery'))
    assert.ok(!lower.includes('recover proposal'))
  })
})
