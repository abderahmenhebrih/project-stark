import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initialModelChainsPanelState, modelChainsPanelReducer, type ModelChainsPanelState } from './model-chains-state'
import { createDefaultFreeBrainChain, createDefaultFreeHeartChain } from './model-library'

function bound(): ModelChainsPanelState {
  return { ...initialModelChainsPanelState(), workspaceId: 7 }
}

function emptyBrain(state: ModelChainsPanelState): ModelChainsPanelState {
  let next = state
  for (const id of [...next.brain]) {
    next = modelChainsPanelReducer(next, { type: 'chain-remove', workspaceId: 7, chain: 'brain', stableId: id })
  }
  return next
}

describe('model chains panel state', () => {
  it('starts with the Free default brain and heart chains', () => {
    const state = bound()
    assert.deepEqual(state.brain, createDefaultFreeBrainChain())
    assert.deepEqual(state.heart, createDefaultFreeHeartChain())
    assert.equal(state.brain.length, 5)
    assert.equal(state.heart.length, 5)
  })

  it('adds to one chain without touching the other', () => {
    let state = emptyBrain(bound())
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
    assert.deepEqual(state.heart, createDefaultFreeHeartChain())
  })

  it('allows the same model across brain and heart but not twice in one chain', () => {
    let state = emptyBrain(bound())
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    // Heart starts full at the Free cap, so make room before proving
    // the cross-chain insert is accepted (duplicates are only
    // same-chain).
    const dropped = state.heart[state.heart.length - 1]
    assert.ok(dropped !== undefined)
    state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'heart', stableId: dropped })
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'heart', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
    assert.ok(state.heart.includes('openai:a'))
    const before = state
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.equal(state, before)
  })

  it('rejects a sixth insertion per chain', () => {
    let state = emptyBrain(bound())
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
    const [first, second, ...rest] = state.heart
    assert.ok(first !== undefined && second !== undefined)
    state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'heart', stableId: second })
    assert.deepEqual(state.heart, [first, ...rest])
  })

  it('reorders while preserving identities', () => {
    let state = bound()
    const ids = [...state.brain]
    const last = ids[ids.length - 1]
    assert.ok(last !== undefined)
    state = modelChainsPanelReducer(state, {
      type: 'chain-move',
      workspaceId: 7,
      chain: 'brain',
      stableId: last,
      direction: 'up'
    })
    const expected = [...ids]
    expected.splice(ids.length - 1, 1)
    expected.splice(ids.length - 2, 0, last)
    assert.deepEqual(state.brain, expected)
  })

  it('keeps chain ids when the library empties (unavailable, never pruned)', () => {
    let state = emptyBrain(bound())
    state = modelChainsPanelReducer(state, { type: 'chain-add', workspaceId: 7, chain: 'brain', stableId: 'openai:a' })
    assert.deepEqual(state.brain, ['openai:a'])
  })

  it('an intentionally emptied chain stays empty (never refilled by defaults)', () => {
    const emptied = emptyBrain(bound())
    assert.deepEqual(emptied.brain, [])
    // Normal updates preserve the explicit empty state.
    const next = modelChainsPanelReducer(emptied, {
      type: 'chain-move',
      workspaceId: 7,
      chain: 'brain',
      stableId: 'builtin:gpt-5.6-luna',
      direction: 'up'
    })
    assert.deepEqual(next.brain, [])
  })

  it('resets to defaults on workspace switch and ignores cross-workspace actions', () => {
    let state = bound()
    state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'brain', stableId: state.brain[0] ?? '' })
    const next = modelChainsPanelReducer(state, { type: 'workspace-changed', workspaceId: 8 })
    assert.equal(next.workspaceId, 8)
    assert.deepEqual(next.brain, createDefaultFreeBrainChain())
    assert.deepEqual(next.heart, createDefaultFreeHeartChain())
    const local = bound()
    assert.equal(
      modelChainsPanelReducer(local, { type: 'chain-add', workspaceId: 8, chain: 'brain', stableId: 'openai:a' }),
      local
    )
  })
})
