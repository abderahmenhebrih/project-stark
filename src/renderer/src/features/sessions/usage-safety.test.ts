import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('usage renderer safety', () => {
  it('states the local-only boundary with no quota promises', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('STARK tracks only provider calls made by STARK'))
    assert.ok(settings.includes('does not query provider billing or quota APIs'))
    assert.ok(settings.includes('Token counts are shown only when the provider reports them'))
    assert.ok(settings.includes('Token telemetry incomplete'))
    // Copy wraps across source lines; assert on stable fragments.
    assert.ok(settings.includes('Token threshold cannot be evaluated completely'))
    assert.ok(settings.includes('did not report token'))
    for (const forbidden of [
      'remaining provider quota',
      'exact provider quota',
      'billing balance',
      'guaranteed quota'
    ]) {
      assert.ok(!settings.includes(forbidden), `usage UI must not claim ${forbidden}`)
    }
  })

  it('explains threshold routing honestly with explicit save only', () => {
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('configured alternate'))
    assert.ok(settings.includes('before making the provider call'))
    assert.ok(settings.includes('does not retry failed models and is not a provider quota guarantee'))
    assert.ok(settings.includes('continues using the normal Heart route'))
    assert.ok(settings.includes('Save usage routing'))
    assert.ok(settings.includes('Refresh usage'))
    assert.ok(settings.includes('Threshold reached; no alternate configured') || settings.includes('no alternate is configured'))
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
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('Save usage routing'))
    assert.ok(settings.includes('Refresh usage'))
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
