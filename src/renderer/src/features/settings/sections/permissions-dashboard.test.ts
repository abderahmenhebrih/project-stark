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
 * Permissions LoopLink-style table with real switches (presentation
 * only): one shared container, Capability/Description/Mode columns,
 * group section rows, one switch per row (OFF = ask, ON = allow where
 * legal), fixed ask-only rows, legacy deny shown as a tiny note until
 * the user flips the switch. Behavior runs through the untouched
 * reducer; structure asserted against source. Deny stays a first-class
 * runtime mode — only its button is gone.
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

describe('permissions switch table structure', () => {
  it('renders one shared table with Capability / Description / Mode columns', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(!page.includes('permissions-card'), 'no card surfaces may remain')
    assert.ok(page.includes('permissions-table'), 'one shared table container must exist')
    assert.ok(page.includes('<table'), 'capabilities must render as a real table')
    for (const header of ['Capability', 'Description', 'Mode']) {
      assert.ok(page.includes(header), `column ${header} must exist`)
    }
  })

  it('master switch lives in the container header', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('permissions-master'), 'master must sit in the table header')
    assert.ok(page.includes('Enable all permissions'), 'master must offer enabling all')
    assert.ok(page.includes('Agent permissions {enabled ?'), 'plain status line must remain')
  })

  it('9 capability rows render in 5 + 2 + 2 group sections', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('CAPABILITY_ORDER'), 'rows must derive from the canonical order')
    for (const group of ['Read & inspect', 'Change & import', 'Execute & generate']) {
      assert.ok(page.includes(group), `group ${group} must exist`)
    }
    assert.deepEqual(CAPABILITY_ORDER.length, 9)
  })

  it('policies render as one real switch, not segmented buttons', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('role="switch"'), 'policies must be real switches')
    assert.ok(page.includes('permissions-switch'), 'switch styling must exist')
    assert.ok(!page.includes('role="radiogroup"'), 'no segmented button groups may remain')
    assert.ok(!page.includes('>Always ask</button>'), 'no Always-ask buttons may remain')
    assert.ok(page.includes('Always ask') && page.includes('Allow'), 'switch flanking labels must exist')
  })

  it('switch maps OFF to ask and ON to allow where legal', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('aria-checked={checked}'), 'checked state must reflect the policy')
    assert.ok(page.includes('const checked = mode === '), 'checked must derive from allow')
    assert.ok(page.includes("mode: checked ? 'ask' : 'allow'"), 'OFF flip must set ask, ON flip must set allow')
  })

  it('ask-only rows render a disabled OFF switch with no Allow path', () => {
    assert.deepEqual(legalModesFor('terminal.execute'), ['deny', 'ask'])
    assert.deepEqual(legalModesFor('attachment.import'), ['deny', 'ask'])
    assert.deepEqual(legalModesFor('image.generate'), ['deny', 'ask'])
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('aria-disabled={!allowLegal}'), 'ask-only must expose its locked state')
    assert.ok(page.includes('Always ask is required for this capability.'), 'ask-only must explain itself')
  })

  it('no normal visible Deny selection exists', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(!page.includes("'Deny'") && !page.includes('>Deny<'), 'no Deny button may render')
  })

  it('legacy deny renders as a tiny note until the user flips the switch', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes("mode === 'deny'"), 'note must derive from the stored mode')
    assert.ok(page.includes('Blocked'), 'stored deny must surface honestly but quietly')
    assert.ok(!page.includes('permissions-blocked'), 'no large Blocked badge may remain')
  })

  it('switches carry accessible names and focus states', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('Allow ${name} without asking'), 'switch must name its capability')
    assert.ok(page.includes('aria-label="Enable Agent Permissions"'), 'master switch must be labelled')
    const css = readRenderer('features/settings/sections/PermissionsSettings.css')
    assert.ok(css.includes(':focus-visible'), 'switches must show focus')
    assert.ok(css.includes('@media'), 'narrow layout must stack without cards')
  })

  it('safety note and save flow are preserved', () => {
    const page = readRenderer('features/settings/sections/PermissionsSettings.tsx')
    assert.ok(page.includes('Permissions only control whether future STARK Worker tools may request an action.'))
    assert.ok(page.includes('Save permissions'))
    assert.ok(!page.includes('.invoke('), 'table must add no IPC')
  })
})

describe('permissions switch behavior (untouched reducer)', () => {
  it('underlying deny mode still exists in runtime/state', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'deny' })
    assert.equal(state.draft.modes['workspace.read'], 'deny')
    assert.deepEqual(legalModesFor('workspace.read'), ['deny', 'ask', 'allow'])
  })

  it('persisted deny survives until an explicit switch flip', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'deny' })
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: false })
    assert.equal(state.draft.modes['workspace.read'], 'deny')
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'ask' })
    assert.equal(state.draft.modes['workspace.read'], 'ask')
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'allow' })
    assert.equal(state.draft.modes['workspace.read'], 'allow')
  })

  it('master Off/On preserves configured policies', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'allow' })
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: false })
    assert.equal(state.draft.enabled, false)
    assert.equal(state.draft.modes['workspace.read'], 'allow')
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: true })
    assert.equal(state.draft.modes['workspace.read'], 'allow')
  })

  it('restricted allow stays rejected and defaults stay deny-everywhere', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'terminal.execute', mode: 'allow' })
    assert.equal(state.draft.modes['terminal.execute'], 'deny')
    const fresh = emptyCapabilityDraft()
    assert.ok(Object.values(fresh.modes).every((mode) => mode === 'deny'))
    const loaded = capabilityDraftFromConfig({ workspaceId: 7, enabled: true, policies: [] })
    assert.equal(loaded.modes['git.read'], 'deny')
  })

  it('capability IDs are unchanged (exactly the 9 source-truth ids)', () => {
    assert.deepEqual([...CAPABILITY_ORDER], [
      'workspace.read', 'workspace.search', 'git.read', 'change.propose', 'attachment.import',
      'image.generate', 'terminal.execute', 'runtime.observe', 'preview.inspect'
    ])
  })
})
