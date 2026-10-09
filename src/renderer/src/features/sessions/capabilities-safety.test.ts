import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('capability renderer safety', () => {
  it('renders permissions as React text with no HTML sinks', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
    assert.ok(!panel.includes('innerHTML'))
  })

  it('has explicit save with no autosave, polling, or tool execution', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('Save permissions'))
    const state = readRenderer('features/sessions/capabilities-state.ts')
    assert.ok(!state.includes('setInterval'))
    assert.ok(!state.includes('setTimeout'))
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('Run tool'))
    assert.ok(!panel.includes('Execute'))
  })

  it('terminal never renders Allow and shows exact-command copy', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('Terminal execution always requires approval for the exact command.'))
    assert.ok(settings.includes('Allowing proposals does not allow STARK to apply them.'))
    assert.ok(settings.includes('Permissions only control whether future STARK Worker tools may request an action.'))
  })

  it('shows all five capability rows with Deny/Ask/Allow where legal', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    for (const label of ['Agent Permissions', 'Workspace Agent Capabilities', 'Disabled', 'Enabled']) {
      assert.ok(settings.includes(label), `settings must contain ${label}`)
    }
  })

  it('exposes no approval dialog, credentials, or provider controls', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    const start = settings.indexOf('Agent Permissions')
    assert.ok(start >= 0)
    const slice = settings.slice(start, start + 12000)
    assert.ok(!slice.includes('Approve command'))
    assert.ok(!slice.includes('apiKey'))
    assert.ok(!slice.includes('Authorization'))
  })

  it('helpers never touch the DOM or Node APIs', () => {
    const state = readRenderer('features/sessions/capabilities-state.ts')
    assert.ok(!state.includes('document.'))
    assert.ok(!state.includes('window.'))
    assert.ok(!state.includes("from 'node:"))
  })
})
