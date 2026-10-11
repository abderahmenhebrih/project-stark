import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_CHAIN_MODELS,
  MIN_CHAIN_MODELS,
  addToChain,
  isChainEntryAvailable,
  isChainFull,
  moveInChain,
  removeFromChain
} from './model-chain'

describe('model chain rules', () => {
  it('configures between one and five models', () => {
    assert.equal(MIN_CHAIN_MODELS, 1)
    assert.equal(MAX_CHAIN_MODELS, 5)
  })

  it('appends in insertion order', () => {
    let chain: readonly string[] = []
    for (const id of ['openai:a', 'openai:b', 'openai:c']) {
      const outcome = addToChain(chain, id)
      assert.equal(outcome.applied, true)
      chain = outcome.chain
    }
    assert.deepEqual(chain, ['openai:a', 'openai:b', 'openai:c'])
  })

  it('rejects same-chain duplicates without reordering', () => {
    const chain = ['openai:a', 'openai:b']
    const outcome = addToChain(chain, 'openai:a')
    assert.equal(outcome.applied, false)
    assert.equal(outcome.reason, 'duplicate-in-chain')
    assert.deepEqual(outcome.chain, chain)
  })

  it('rejects a sixth insertion in state logic', () => {
    const chain = ['openai:1', 'openai:2', 'openai:3', 'openai:4', 'openai:5']
    assert.equal(isChainFull(chain), true)
    assert.equal(isChainFull(['openai:1']), false)
    const outcome = addToChain(chain, 'openai:6')
    assert.equal(outcome.applied, false)
    assert.equal(outcome.reason, 'chain-full')
    assert.deepEqual(outcome.chain, chain)
  })

  it('removes the middle entry and collapses positions', () => {
    assert.deepEqual(removeFromChain(['openai:1', 'openai:2', 'openai:3', 'openai:4'], 'openai:3'), [
      'openai:1',
      'openai:2',
      'openai:4'
    ])
    const chain = ['openai:1']
    assert.equal(removeFromChain(chain, 'openai:missing'), chain)
  })

  it('reorders while preserving identities', () => {
    const chain = ['openai:a', 'openai:b', 'openai:c']
    assert.deepEqual(moveInChain(chain, 'openai:b', 'left'), ['openai:b', 'openai:a', 'openai:c'])
    assert.deepEqual(moveInChain(chain, 'openai:b', 'right'), ['openai:a', 'openai:c', 'openai:b'])
    assert.deepEqual(moveInChain(chain, 'openai:a', 'left'), chain)
    assert.deepEqual(moveInChain(chain, 'openai:c', 'right'), chain)
    assert.deepEqual(moveInChain(chain, 'openai:missing', 'left'), chain)
  })

  it('marks entries missing from the library as unavailable (never dangling)', () => {
    const libraryIds = new Set(['openai:a'])
    assert.equal(isChainEntryAvailable(libraryIds, 'openai:a'), true)
    assert.equal(isChainEntryAvailable(libraryIds, 'openai:gone'), false)
    assert.equal(isChainEntryAvailable(new Set(), 'openai:a'), false)
  })
})
