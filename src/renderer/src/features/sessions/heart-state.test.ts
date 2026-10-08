import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HeartConfig } from '../../../../shared/heart/types'
import {
  emptyHeartDraft,
  heartDraftFromConfig,
  heartPanelReducer,
  initialHeartPanelState,
  type HeartPanelState
} from './heart-state'

function savedConfig(): HeartConfig {
  return {
    workerMode: 'auto_swap',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: null,
    workerDefault: { providerId: 'openai', model: 'model-D' },
    workerRoutes: {
      general: null,
      coding: { providerId: 'openai', model: 'model-C' },
      reasoning: null,
      fast: null
    }
  }
}

function bound(): HeartPanelState {
  return { ...initialHeartPanelState(), workspaceId: 7 }
}

describe('heart settings state', () => {
  it('loads null config into a blank draft', () => {
    let state = bound()
    state = heartPanelReducer(state, { type: 'config-loading', workspaceId: 7 })
    assert.equal(state.loading, true)
    state = heartPanelReducer(state, { type: 'config-loaded', workspaceId: 7, config: null })
    assert.equal(state.loading, false)
    assert.equal(state.config, null)
    assert.deepEqual(state.draft, emptyHeartDraft())
  })

  it('loads a saved config into the draft', () => {
    let state = bound()
    state = heartPanelReducer(state, { type: 'config-loaded', workspaceId: 7, config: savedConfig() })
    assert.equal(state.draft.workerMode, 'auto_swap')
    assert.equal(state.draft.brain.model, 'model-A')
    assert.equal(state.draft.workerRoutes.coding.model, 'model-C')
    assert.deepEqual(heartDraftFromConfig(savedConfig()).workerDefault, { providerId: 'openai', model: 'model-D' })
  })

  it('mode toggle and draft edits never persist on their own', () => {
    let state = bound()
    state = heartPanelReducer(state, { type: 'mode-selected', workspaceId: 7, mode: 'auto_swap' })
    assert.equal(state.draft.workerMode, 'auto_swap')
    assert.equal(state.config, null)
    state = heartPanelReducer(state, {
      type: 'draft-edited',
      workspaceId: 7,
      field: { scope: 'brain' },
      providerId: 'openai',
      model: 'model-X'
    })
    assert.equal(state.draft.brain.model, 'model-X')
    assert.equal(state.config, null)
    state = heartPanelReducer(state, {
      type: 'draft-edited',
      workspaceId: 7,
      field: { scope: 'route', profile: 'fast' },
      providerId: 'openai',
      model: 'model-F'
    })
    assert.equal(state.draft.workerRoutes.fast.model, 'model-F')
  })

  it('explicit save succeeds with confirmation and refreshes the draft', () => {
    let state: HeartPanelState = { ...bound(), saving: false }
    state = heartPanelReducer(state, { type: 'save-started', workspaceId: 7 })
    assert.equal(state.saving, true)
    state = heartPanelReducer(state, { type: 'save-succeeded', workspaceId: 7, config: savedConfig() })
    assert.equal(state.saving, false)
    assert.equal(state.notice, 'Heart configuration saved.')
    assert.equal(state.draft.workerDefault.model, 'model-D')
  })

  it('save failure keeps the draft for correction', () => {
    let state: HeartPanelState = { ...bound(), saving: true }
    state = heartPanelReducer(state, { type: 'save-failed', workspaceId: 7, message: 'boom' })
    assert.equal(state.saving, false)
    assert.equal(state.saveError, 'boom')
  })

  it('workspace switch resets heart state', () => {
    const state: HeartPanelState = { ...bound(), config: savedConfig(), notice: 'saved' }
    const next = heartPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(next.workspaceId, 8)
    assert.equal(next.config, null)
    assert.equal(next.notice, null)
  })

  it('ignores cross-workspace outcomes', () => {
    const state = bound()
    assert.equal(heartPanelReducer(state, { type: 'config-loaded', workspaceId: 8, config: savedConfig() }), state)
    assert.equal(
      heartPanelReducer(state, { type: 'save-succeeded', workspaceId: 8, config: savedConfig() }),
      state
    )
  })
})
