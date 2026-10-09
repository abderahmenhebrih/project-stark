import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  USAGE_ROUTE_KEYS,
  emptyUsageDraft,
  initialUsagePanelState,
  usageDraftFromConfig,
  usagePanelReducer,
  usageRouteLabel,
  type UsagePanelState
} from './usage-state'

function bound(): UsagePanelState {
  return { ...initialUsagePanelState(), workspaceId: 7 }
}

describe('usage panel state', () => {
  it('starts disabled with empty limits and no autosave surface', () => {
    const state = initialUsagePanelState()
    assert.equal(state.workspaceId, null)
    assert.equal(state.draft.thresholdRoutingEnabled, false)
    assert.deepEqual(state.draft.limits, [])
    assert.ok(USAGE_ROUTE_KEYS.every((key) => state.draft.alternates[key].model === ''))
    assert.equal(state.saving, false)
    assert.equal(state.summary, null)
  })

  it('loads a saved config into the draft', () => {
    let state = bound()
    state = usagePanelReducer(state, {
      type: 'config-loaded',
      workspaceId: 7,
      config: {
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-A', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      }
    })
    assert.equal(state.draft.thresholdRoutingEnabled, true)
    assert.equal(state.draft.limits.length, 1)
    assert.equal(state.draft.alternates['brain.primary'].model, 'model-X')
    assert.equal(state.draft.alternates['worker.fixed'].model, '')
  })

  it('routing toggle edits draft only', () => {
    let state = bound()
    state = usagePanelReducer(state, { type: 'routing-toggled', workspaceId: 7, enabled: true })
    assert.equal(state.draft.thresholdRoutingEnabled, true)
    assert.equal(state.config, null)
  })

  it('limit rows add, edit, and remove explicitly', () => {
    let state = bound()
    state = usagePanelReducer(state, { type: 'limit-added', workspaceId: 7 })
    assert.equal(state.draft.limits.length, 1)
    const current = state.draft.limits[0]
    assert.ok(current !== undefined)
    state = usagePanelReducer(state, { type: 'limit-edited', workspaceId: 7, index: 0, limit: { ...current, model: 'model-A', maxCalls: '50' } })
    assert.equal(state.draft.limits[0]?.model, 'model-A')
    state = usagePanelReducer(state, { type: 'limit-removed', workspaceId: 7, index: 0 })
    assert.equal(state.draft.limits.length, 0)
  })

  it('summary loads explicitly with no polling state', () => {
    let state = bound()
    state = usagePanelReducer(state, { type: 'summary-loading', workspaceId: 7 })
    assert.equal(state.summaryLoading, true)
    state = usagePanelReducer(state, {
      type: 'summary-loaded',
      workspaceId: 7,
      summary: { models: [], truncated: false, windowMs: 86400000, heartThresholdRoutingEnabled: false }
    })
    assert.equal(state.summaryLoading, false)
    assert.deepEqual(state.summary?.models, [])
  })

  it('explicit save succeeds with confirmation and refreshes the draft', () => {
    let state = bound()
    state = usagePanelReducer(state, { type: 'save-started', workspaceId: 7 })
    assert.equal(state.saving, true)
    const config = {
      heartThresholdRoutingEnabled: true,
      limits: [],
      alternates: [{ routeKey: 'brain.primary' as const, providerId: 'openai', model: 'model-X' }]
    }
    state = usagePanelReducer(state, { type: 'save-succeeded', workspaceId: 7, config })
    assert.equal(state.saving, false)
    assert.equal(state.notice, 'Usage routing saved.')
  })

  it('save failure keeps the draft for correction', () => {
    let state: UsagePanelState = { ...initialUsagePanelState(), workspaceId: 7, saving: true, draft: emptyUsageDraft() }
    state = usagePanelReducer(state, { type: 'save-failed', workspaceId: 7, message: 'We couldn’t save the usage routing configuration.' })
    assert.equal(state.saving, false)
    assert.ok((state.saveError ?? '').length > 0)
  })

  it('workspace switch loads a separate config', () => {
    const reset = usagePanelReducer(bound(), { type: 'workspace-changed', workspaceId: 9 })
    assert.equal(reset.workspaceId, 9)
    assert.equal(reset.draft.thresholdRoutingEnabled, false)
    assert.equal(reset.summary, null)
  })

  it('ignores cross-workspace outcomes', () => {
    let state = bound()
    state = usagePanelReducer(state, { type: 'config-loading', workspaceId: 999 })
    assert.equal(state.loading, false)
  })

  it('labels all seven routes', () => {
    assert.deepEqual([...USAGE_ROUTE_KEYS], [
      'brain.primary', 'worker.fixed', 'worker.default', 'worker.general', 'worker.coding', 'worker.reasoning', 'worker.fast'
    ])
    assert.equal(usageRouteLabel('brain.primary'), 'Brain')
    assert.equal(usageRouteLabel('worker.coding'), 'Worker Coding')
    const draft = usageDraftFromConfig({ heartThresholdRoutingEnabled: false, limits: [], alternates: [] })
    assert.equal(draft.thresholdRoutingEnabled, false)
  })
})
