import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  CAPABILITY_ORDER,
  capabilityDraftFromConfig,
  capabilityPanelReducer,
  emptyCapabilityDraft,
  initialCapabilityPanelState,
  legalModesFor,
  type CapabilityPanelState
} from '../../sessions/capabilities-state'

/**
 * Permissions dashboard redesign (visual/layout only): global card,
 * grouped 2-column grid, segmented single-choice policies. Behavior
 * runs through the untouched reducer; structure asserted against
 * source. Security semantics pinned: same 9 ids, same legal modes,
 * same default-deny, same explicit save, no schema/IPC changes.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function bound(): CapabilityPanelState {
  return { ...initialCapabilityPanelState(), workspaceId: 7 }
}

describe('permissions dashboard structure', () => {
  it('global Agent Permissions card exists with a single switch', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('Agent Permissions'), 'global card must exist')
    assert.ok(page.includes('permissions-global'), 'global card must be one horizontal surface')
    assert.ok(page.includes('Disabled') && page.includes('Enabled'), 'switch must offer Disabled/Enabled')
  })

  it('capability cards render from source truth in three groups', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    for (const group of ['Read & inspect', 'Change & import', 'Execute & generate']) {
      assert.ok(page.includes(group), `group ${group} must exist`)
    }
    assert.ok(page.includes('CAPABILITY_ORDER'), 'cards must derive from the canonical order')
    const css = readRenderer('features/settings/sections/PermissionsSettings.css')
    assert.ok(css.includes('.permissions-grid'), 'cards must sit in a grid')
  })

  it('desktop grid uses 2 columns and stacks narrow', () => {
    const css = readRenderer('features/settings/sections/PermissionsSettings.css')
    const grid = css.match(/\.permissions-grid\s*\{[^}]*\}/)
    assert.ok(grid !== null && grid[0].includes('repeat(2,'), 'desktop grid must be 2 columns')
    assert.ok(css.includes('@media'), 'narrow layout must stack to one column')
  })

  it('policies render as one segmented single-choice control', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('role="radiogroup"'), 'policy must use single-choice semantics')
    assert.ok(page.includes('role="radio"'), 'options must be radios, not unrelated toggles')
    assert.ok(page.includes('aria-checked'), 'selection must be exposed')
    assert.ok(page.includes('permissions-segment'), 'options must read as one control')
  })

  it('restricted capabilities still offer no Allow', () => {
    assert.deepEqual(legalModesFor('terminal.execute'), ['deny', 'ask'])
    assert.deepEqual(legalModesFor('attachment.import'), ['deny', 'ask'])
    assert.deepEqual(legalModesFor('image.generate'), ['deny', 'ask'])
    assert.deepEqual(legalModesFor('workspace.read'), ['deny', 'ask', 'allow'])
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('legalModesFor(capability).map'), 'options must come from legal modes only')
  })

  it('only execution-effect capabilities carry the Sensitive flag', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('Sensitive'), 'sensitive capabilities must stand out')
    assert.ok(page.includes("'terminal.execute', 'image.generate'"), 'exactly terminal + image generation qualify')
  })

  it('descriptions stay security-honest with the human-review warning', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('Terminal execution always requires approval for the exact command.'))
    assert.ok(page.includes('Allowing proposals does not allow STARK to apply them.'))
    assert.ok(page.includes('Permissions only control whether future STARK Worker tools may request an action.'))
  })

  it('icons come from the existing local set (no new dependencies)', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('StarkIcon'), 'cards must use the local glyph set')
    assert.ok(!page.includes('.invoke('), 'dashboard must add no IPC')
  })
})

describe('permissions dashboard behavior (untouched reducer)', () => {
  it('covers exactly the 9 source-truth capabilities in canonical order', () => {
    assert.deepEqual([...CAPABILITY_ORDER], [
      'workspace.read', 'workspace.search', 'git.read', 'change.propose', 'attachment.import',
      'image.generate', 'terminal.execute', 'runtime.observe', 'preview.inspect'
    ])
  })

  it('global Disabled preserves configured policies (nothing erased, nothing reset)', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'allow' })
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: false })
    assert.equal(state.draft.enabled, false)
    assert.equal(state.draft.modes['workspace.read'], 'allow')
  })

  it('enabling mutates no individual policy values', () => {
    let state = bound()
    const before = { ...state.draft.modes }
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: true })
    assert.deepEqual({ ...state.draft.modes }, before)
  })

  it('draft edits stay explicit-save (no autosave surface)', () => {
    const draft = emptyCapabilityDraft()
    assert.equal(draft.enabled, false)
    const loaded = capabilityDraftFromConfig({ workspaceId: 7, enabled: true, policies: [] })
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.modes['git.read'], 'deny')
  })
})
