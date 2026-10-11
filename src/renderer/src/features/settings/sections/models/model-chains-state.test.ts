import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initialModelChainsPanelState, modelChainsPanelReducer, type ModelChainsPanelState } from './model-chains-state'

function bound(): ModelChainsPanelState {
  return { ...initialModelChainsPanelState(), workspaceId: 7 }
}

describe('model chains panel state', () => {
  it('starts with empty brain and heart chains', () => {
    const state = bound()
    assert.deepEqual(state.brain, [])
    assert.deepEqual(state.heart, [])
  })

  it('adds to one chain without touching the other', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
    assert.deepEqual(state.heart, [])
  })

  it('allows the same model across brain and heart but not twice in one chain', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'heart', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
    assert.deepEqual(state.heart, ['openai:a'])
    const before = state
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.equal(state, before)
  })

  it('rejects a sixth insertion per chain', () => {
    let state = bound()
    for (const id of ['openai:1', 'openai:2', 'openai:3', 'openai:4', 'openai:5']) {
      state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: id })
    }
    assert.equal(state.brain.length, 5)
    const before = state
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:6' })
    assert.equal(state, before)
  })

  it('removes and reindexes without holes', () => {
    let state = bound()
    for (const id of ['openai:1', 'openai:2', 'openai:3']) {
      state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'heart', stableId: id })
    }
    state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'heart', stableId: 'openai:2' })
    assert.deepEqual(state.heart, ['openai:1', 'openai:3'])
  })

  it('reorders while preserving identities', () => {
    let state = bound()
    for (const id of ['openai:a', 'openai:b', 'openai:c']) {
      state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: id })
    }
    state = modelChainsPanelReducer(state, {
      type: 'chain-move',
      workspaceId: 7,
      chain: 'brain',
      stableId: 'openai:c',
      direction: 'left'
    })
    assert.deepEqual(state.brain, ['openai:a', 'openai:c', 'openai:b'])
  })

  it('keeps chain ids when the library empties (unavailable, never pruned)', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
  })

  it('resets on workspace switch and ignores cross-workspace actions', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    const next = modelChainsPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(next.workspaceId, 8)
    assert.deepEqual(next.brain, [])
    assert.deepEqual(next.heart, [])
    const local = bound()
    assert.equal(
      modelChainsPanelReducer(local, { type: 'chain-add', workspaceId: 8, chain: 'brain', stableId: 'openai:a' }),
      local
    )
  })
})
