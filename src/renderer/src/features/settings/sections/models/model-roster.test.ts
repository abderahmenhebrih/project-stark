import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_CHAIN_MODELS, deriveModelRoster, disableModel, enableModel, reorderEnabledModel, swapEnabledModel } from './model-chain'
import { createDefaultFreeBrainChain, createDefaultFreeHeartChain, deriveModelLibrary } from './model-library'
import { defaultProductState, deriveAccountEntitlements } from '../../../billing/entitlements'
import { initialProviderPanelState } from '../../../sessions/provider-state'
import { initialModelChainsPanelState, modelChainsPanelReducer, type ModelChainsPanelState } from './model-chains-state'

/**
 * LoopLink roster semantics: one ordered-enabled-ids truth source,
 * derived rosters (preview catalog entries are never offered — only
 * routed provider models appear as available), toggle/swap/reorder
 * purity, entitlement caps, and cross-chain independence. Behavior
 * runs directly here.
 */
function freeLibrary(): ReturnType<typeof deriveModelLibrary> {
  return deriveModelLibrary(initialProviderPanelState())
}

function configuredLibrary(): ReturnType<typeof deriveModelLibrary> {
  return deriveModelLibrary({
    ...initialProviderPanelState(),
    configured: true,
    selectedModel: 'gpt-4o',
    models: [{ id: 'gpt-4o' }, { id: 'o3-mini' }]
  })
}

function bound(): ModelChainsPanelState {
  return { ...initialModelChainsPanelState(), workspaceId: 7 }
}

describe('roster derivation', () => {
  it('Brain keeps its 5 default positions; preview catalog is never offered as available', () => {
    const roster = deriveModelRoster(freeLibrary(), createDefaultFreeBrainChain())
    assert.equal(roster.enabledCount, 5)
    assert.deepEqual(
      roster.rows.filter((row) => row.enabled).map((row) => row.stableId),
      createDefaultFreeBrainChain()
    )
    // Unrouted preview entries cannot be newly enabled: no disabled rows.
    assert.ok(roster.rows.every((row) => row.enabled))
    assert.equal(roster.totalCount, 5)
  })

  it('Heart keeps its own 5 default positions with no available preview rows', () => {
    const roster = deriveModelRoster(freeLibrary(), createDefaultFreeHeartChain())
    assert.equal(roster.rows.length, 5)
    assert.equal(roster.enabledCount, 5)
    assert.deepEqual(
      roster.rows.filter((row) => row.enabled).map((row) => row.stableId),
      createDefaultFreeHeartChain()
    )
  })

  it('configured provider models appear as the only available rows', () => {
    const roster = deriveModelRoster(configuredLibrary(), [])
    assert.equal(roster.enabledCount, 0)
    assert.deepEqual(
      roster.rows.map((row) => row.stableId),
      ['openai:gpt-4o', 'openai:o3-mini']
    )
    assert.ok(roster.rows.every((row) => !row.enabled && row.entry !== undefined))
  })

  it('retained active ids missing from the catalog stay enabled (never phantom, never crash)', () => {
    const roster = deriveModelRoster(freeLibrary(), ['builtin:retired-model'])
    assert.equal(roster.enabledCount, 1)
    assert.equal(roster.rows[0]?.stableId, 'builtin:retired-model')
    assert.equal(roster.rows[0]?.entry, undefined)
  })

  it('empty active chain with no provider offers no available rows (preview is not selectable)', () => {
    const roster = deriveModelRoster(freeLibrary(), [])
    assert.equal(roster.enabledCount, 0)
    assert.equal(roster.rows.length, 0)
  })
})

describe('toggle below limit', () => {
  it('disable collapses order with no holes; row stays derivable', () => {
    const active = ['a', 'b', 'c', 'd', 'e']
    const outcome = disableModel(active, 'c')
    assert.equal(outcome.applied, true)
    assert.deepEqual(outcome.chain, ['a', 'b', 'd', 'e'])
  })

  it('re-enable appends to the END of active order', () => {
    const outcome = enableModel(['a', 'b', 'd', 'e'], 'c', 5)
    assert.equal(outcome.applied, true)
    assert.deepEqual(outcome.chain, ['a', 'b', 'd', 'e', 'c'])
  })

  it('disabling an absent id changes nothing', () => {
    const outcome = disableModel(['a'], 'zzz')
    assert.equal(outcome.applied, false)
    assert.deepEqual(outcome.chain, ['a'])
  })
})

describe('limit reached', () => {
  it('sixth enable refuses with limitReached and preserves state', () => {
    const outcome = enableModel(['a', 'b', 'c', 'd', 'e'], 'x', 5)
    assert.equal(outcome.applied, false)
    assert.equal(outcome.limitReached, true)
    assert.deepEqual(outcome.chain, ['a', 'b', 'c', 'd', 'e'])
  })

  it('reducer holds the cap defensively (dialog owns the UX)', () => {
    let state = bound()
    const before = state
    state = modelChainsPanelReducer(state, { type: 'model-enabled', workspaceId: 7, chain: 'brain', stableId: 'builtin:mimo-v2.6-pro' })
    assert.equal(state, before)
    assert.equal(state.brain.length, 5)
  })
})

describe('switch model', () => {
  it('incoming takes the replaced position; count preserved; no duplicate', () => {
    const outcome = swapEnabledModel(
      ['builtin:gpt-5.6-luna', 'builtin:deepseek-v4.1-flash', 'builtin:gemini-2.5-flash', 'builtin:claude-haiku-5.5', 'builtin:glm-5.3-flash'],
      'builtin:gemini-2.5-flash',
      'builtin:minimax-m3'
    )
    assert.equal(outcome.applied, true)
    assert.deepEqual(outcome.chain, [
      'builtin:gpt-5.6-luna',
      'builtin:deepseek-v4.1-flash',
      'builtin:minimax-m3',
      'builtin:claude-haiku-5.5',
      'builtin:glm-5.3-flash'
    ])
  })

  it('swap rejects unknown outgoing and duplicate incoming', () => {
    assert.equal(swapEnabledModel(['a', 'b'], 'zzz', 'x').applied, false)
    assert.equal(swapEnabledModel(['a', 'b'], 'a', 'b').applied, false)
  })

  it('reducer swap keeps count and position', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, {
      type: 'model-swapped',
      workspaceId: 7,
      chain: 'brain',
      outgoingId: 'builtin:gemini-2.5-flash',
      incomingId: 'builtin:minimax-m3'
    })
    assert.equal(state.brain.length, 5)
    assert.equal(state.brain[2], 'builtin:minimax-m3')
    assert.ok(!state.brain.includes('builtin:gemini-2.5-flash'))
  })
})

describe('drag reorder purity', () => {
  it('drag E to index 1 yields A E B C D with count unchanged', () => {
    assert.deepEqual(reorderEnabledModel(['a', 'b', 'c', 'd', 'e'], 'e', 1), ['a', 'e', 'b', 'c', 'd'])
  })

  it('reorder changes only order (nothing enables/disables)', () => {
    const next = reorderEnabledModel(['a', 'b', 'c'], 'c', 0)
    assert.deepEqual(next, ['c', 'a', 'b'])
    assert.equal(next.length, 3)
  })

  it('out-of-range targets clamp; unknown ids no-op', () => {
    assert.deepEqual(reorderEnabledModel(['a', 'b'], 'b', 99), ['a', 'b'])
    assert.deepEqual(reorderEnabledModel(['a', 'b'], 'a', -5), ['a', 'b'])
    assert.deepEqual(reorderEnabledModel(['a', 'b'], 'zzz', 0), ['a', 'b'])
  })

  it('reducer reorder obeys workspace isolation', () => {
    const state = bound()
    const next = modelChainsPanelReducer(state, { type: 'model-reordered', workspaceId: 8, chain: 'brain', stableId: 'x', toIndex: 0 })
    assert.equal(next, state)
  })
})

describe('cross-chain independence', () => {
  it('brain toggle/reorder never mutates heart (same model may stay ON in both)', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'model-disabled', workspaceId: 7, chain: 'brain', stableId: 'builtin:gpt-5.6-luna' })
    assert.ok(!state.brain.includes('builtin:gpt-5.6-luna'))
    assert.ok(state.heart.includes('builtin:gpt-5.6-luna'))
    state = modelChainsPanelReducer(state, { type: 'model-reordered', workspaceId: 7, chain: 'brain', stableId: state.brain[0] ?? '', toIndex: 3 })
    assert.deepEqual(state.heart, createDefaultFreeHeartChain())
  })
})

describe('entitlement caps without hardcoding', () => {
  it('caps derive centrally: 5/10/15/25 gate enable outcomes', () => {
    const caps: Array<[string, number]> = [
      ['free', 5],
      ['magma', 10],
      ['frost', 15]
    ]
    for (const [plan, max] of caps) {
      const entitlements = deriveAccountEntitlements({ ...defaultProductState(), basePlan: plan as 'free' | 'magma' | 'frost' })
      assert.equal(entitlements.maxBrainModels, max, `${plan} cap`)
      const full = Array.from({ length: max }, (_, index) => `m:${String(index)}`)
      assert.equal(enableModel(full, 'm:next', max).limitReached, true)
      assert.equal(enableModel(full.slice(0, max - 1), 'm:next', max).applied, true)
    }
    const funded = deriveAccountEntitlements({ basePlan: 'free', voidWallet: { activatedEver: true, balanceMicros: 5000000 } })
    assert.equal(funded.maxBrainModels, 25)
    assert.equal(MAX_CHAIN_MODELS, 5)
    assert.equal(deriveAccountEntitlements(defaultProductState()).planLabel, 'STARK Free')
    assert.equal(deriveAccountEntitlements({ ...defaultProductState(), basePlan: 'magma' }).planLabel, 'STARK Magma')
  })
})
