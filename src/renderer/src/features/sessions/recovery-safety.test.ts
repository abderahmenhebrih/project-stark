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
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Save Recovery'))
    assert.ok(!panel.includes('setInterval'))
    assert.ok(!panel.includes('setTimeout'))
    const state = readRenderer('features/sessions/recovery-state.ts')
    assert.ok(!state.includes('setInterval'))
    assert.ok(!state.includes('setTimeout'))
  })

  it('no fake percentages or countdowns in recovery UI', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    // No progress percentages near recovery copy.
    const recoveryIndex = panel.indexOf('Continuity Recovery')
    assert.ok(recoveryIndex >= 0)
    const slice = panel.slice(Math.max(0, recoveryIndex - 2000), recoveryIndex + 8000)
    assert.ok(!slice.includes('%'))
    assert.ok(!slice.toLowerCase().includes('countdown'))
  })

  it('no credentials or raw provider bodies in recovery UI', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const recoveryIndex = panel.indexOf('Continuity Recovery')
    const slice = panel.slice(recoveryIndex, recoveryIndex + 8000)
    assert.ok(!slice.toLowerCase().includes('api key') || slice.includes('Brain Recovery'))
    assert.ok(!slice.includes('Authorization'))
    const api = readRenderer('lib/recovery-api.ts')
    assert.ok(!api.includes('apiKey'))
  })

  it('recovery copy matches spec (handoff + auto-once)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Create a Looplink recovery session after a recoverable provider failure'))
    assert.ok(panel.includes('Create one Looplink recovery session and make one attempt'))
    assert.ok(panel.includes('STARK will not retry'))
  })

  it('no proposal recovery UI exists', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    const lower = panel.toLowerCase()
    assert.ok(!lower.includes('proposal recovery'))
    assert.ok(!lower.includes('recover proposal'))
  })
})
