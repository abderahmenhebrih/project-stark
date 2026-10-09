import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CAPABILITY_ORDER,
  capabilityDraftFromConfig,
  capabilityLabel,
  capabilityPanelReducer,
  emptyCapabilityDraft,
  initialCapabilityPanelState,
  legalModesFor,
  type CapabilityPanelState
} from './capabilities-state'

function bound(): CapabilityPanelState {
  return { ...initialCapabilityPanelState(), workspaceId: 7 }
}

describe('capability panel state', () => {
  it('starts disabled with all deny and no autosave surface', () => {
    const state = initialCapabilityPanelState()
    assert.equal(state.workspaceId, null)
    assert.equal(state.draft.enabled, false)
    assert.ok(CAPABILITY_ORDER.every((c) => state.draft.modes[c] === 'deny'))
    assert.equal(state.saving, false)
  })

  it('loads a saved config into the draft', () => {
    let state = bound()
    state = capabilityPanelReducer(state, {
      type: 'config-loaded',
      workspaceId: 7,
      config: {
        workspaceId: 7,
        enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'ask' },
          { capability: 'git.read', mode: 'allow' },
          { capability: 'change.propose', mode: 'ask' },
          { capability: 'terminal.execute', mode: 'deny' },
          { capability: 'runtime.observe', mode: 'deny' },
          { capability: 'preview.inspect', mode: 'deny' }
        ]
      }
    })
    assert.equal(state.draft.enabled, true)
    assert.equal(state.draft.modes['workspace.read'], 'allow')
  })

  it('master toggle edits draft only and preserves modes while disabled', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: true })
    assert.equal(state.draft.enabled, true)
    assert.equal(state.config, null)
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'workspace.read', mode: 'allow' })
    assert.equal(state.draft.modes['workspace.read'], 'allow')
    state = capabilityPanelReducer(state, { type: 'enabled-toggled', workspaceId: 7, enabled: false })
    assert.equal(state.draft.enabled, false)
    assert.equal(state.draft.modes['workspace.read'], 'allow')
  })

  it('terminal allow is rejected in the reducer', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'terminal.execute', mode: 'allow' })
    assert.equal(state.draft.modes['terminal.execute'], 'deny')
    state = capabilityPanelReducer(state, { type: 'mode-selected', workspaceId: 7, capability: 'terminal.execute', mode: 'ask' })
    assert.equal(state.draft.modes['terminal.execute'], 'ask')
  })

  it('explicit save succeeds with confirmation and refreshes the draft', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'save-started', workspaceId: 7 })
    assert.equal(state.saving, true)
    const config = {
      workspaceId: 7,
      enabled: true,
      policies: [
        { capability: 'workspace.read' as const, mode: 'allow' as const },
        { capability: 'workspace.search' as const, mode: 'ask' as const },
        { capability: 'git.read' as const, mode: 'allow' as const },
        { capability: 'change.propose' as const, mode: 'ask' as const },
        { capability: 'terminal.execute' as const, mode: 'deny' as const },
        { capability: 'runtime.observe' as const, mode: 'deny' as const },
        { capability: 'preview.inspect' as const, mode: 'deny' as const }
      ]
    }
    state = capabilityPanelReducer(state, { type: 'save-succeeded', workspaceId: 7, config })
    assert.equal(state.saving, false)
    assert.equal(state.notice, 'Workspace permissions saved.')
  })

  it('save failure keeps the draft for correction', () => {
    let state: CapabilityPanelState = { ...initialCapabilityPanelState(), workspaceId: 7, saving: true, draft: emptyCapabilityDraft() }
    state = capabilityPanelReducer(state, { type: 'save-failed', workspaceId: 7, message: 'We couldn’t save the workspace permissions.' })
    assert.equal(state.saving, false)
    assert.ok((state.saveError ?? '').length > 0)
  })

  it('workspace switch loads a separate config', () => {
    const reset = capabilityPanelReducer(bound(), { type: 'workspace-changed', workspaceId: 9 })
    assert.equal(reset.workspaceId, 9)
    assert.equal(reset.draft.enabled, false)
  })

  it('ignores cross-workspace outcomes', () => {
    let state = bound()
    state = capabilityPanelReducer(state, { type: 'config-loading', workspaceId: 999 })
    assert.equal(state.loading, false)
  })

  it('labels all seven rows and legal modes', () => {
    assert.deepEqual([...CAPABILITY_ORDER], ['workspace.read', 'workspace.search', 'git.read', 'change.propose', 'terminal.execute', 'runtime.observe', 'preview.inspect'])
    assert.equal(capabilityLabel('workspace.read'), 'Workspace file read')
    assert.equal(capabilityLabel('terminal.execute'), 'Terminal execute')
    assert.equal(capabilityLabel('runtime.observe'), 'Runtime observation')
    assert.equal(capabilityLabel('preview.inspect'), 'Live Preview inspection')
    assert.deepEqual([...legalModesFor('terminal.execute')], ['deny', 'ask'])
    assert.deepEqual([...legalModesFor('git.read')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('runtime.observe')], ['deny', 'ask', 'allow'])
    assert.deepEqual([...legalModesFor('preview.inspect')], ['deny', 'ask', 'allow'])
    const draft = capabilityDraftFromConfig({
      workspaceId: 1,
      enabled: false,
      policies: CAPABILITY_ORDER.map((capability) => ({ capability, mode: 'deny' as const }))
    })
    assert.equal(draft.enabled, false)
  })
})
