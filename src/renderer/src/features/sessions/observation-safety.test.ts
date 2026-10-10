import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CAPABILITY_ORDER, capabilityDescription, capabilityLabel, legalModesFor } from './capabilities-state'
import { formatPreviewElementForDisplay } from './runtime-state'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

describe('stage 27 observation renderer contract', () => {
  it('exposes nine permission rows with safe copy', () => {
    assert.deepEqual([...CAPABILITY_ORDER], [
      'workspace.read', 'workspace.search', 'git.read', 'change.propose', 'attachment.import', 'image.generate', 'terminal.execute', 'runtime.observe', 'preview.inspect'
    ])
    assert.equal(capabilityLabel('runtime.observe'), 'Runtime observation')
    assert.equal(capabilityLabel('preview.inspect'), 'Live Preview inspection')
    assert.deepEqual([...legalModesFor('runtime.observe')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('preview.inspect')], ['deny', 'ask', 'allow'])
    assert.ok(capabilityDescription('runtime.observe').includes('bounded stdout/stderr logs'))
    assert.ok(capabilityDescription('preview.inspect').includes('does not allow clicking'))
  })

  it('approval UI carries observation copy', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Capability: Runtime observation'))
    assert.ok(panel.includes('Action: Observe managed runtime'))
    assert.ok(panel.includes('Capability: Live Preview inspection'))
    assert.ok(panel.includes('Action: Inspect rendered Live Preview'))
    assert.ok(panel.includes('does not allow STARK Worker to stop'))
    assert.ok(panel.includes('does not click, type, submit forms'))
    assert.ok(panel.includes('Deny'))
    assert.ok(panel.includes('Approve'))
    assert.ok(!panel.includes('arbitrary URL field'))
  })

  it('preview result UI renders inert text with truncation notice', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('PREVIEW_TRUNCATION_NOTICE'))
    const state = readRenderer('features/sessions/runtime-state.ts')
    assert.ok(state.includes('Some Preview content was omitted to stay within the inspection limit.'))
    assert.equal(formatPreviewElementForDisplay({ tag: 'a', role: null, type: null, name: null, ariaLabel: null, text: 'Dashboard', href: '/dashboard' }), 'Link — "Dashboard" — /dashboard')
    assert.equal(formatPreviewElementForDisplay({ tag: 'button', role: null, type: null, name: null, ariaLabel: null, text: 'Save', href: null }), 'Button — "Save"')
  })

  it('observation content renders as inert text (no HTML execution)', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('dangerouslySetInnerHTML'))
    assert.ok(!panel.includes('innerHTML'))
    const safety = readRenderer('features/sessions/session-content-safety.test.ts')
    void safety
  })

  it('has no observation polling or auto-refresh loops', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('setInterval'))
    assert.ok(!panel.includes('observeRuntime'))
    assert.ok(!panel.includes('inspectPreview'))
  })
})
