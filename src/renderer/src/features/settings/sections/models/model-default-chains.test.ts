import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  FREE_CATALOG_COUNT,
  createDefaultFreeBrainChain,
  createDefaultFreeHeartChain,
  deriveModelLibrary,
  stableModelId
} from './model-library'
import { MAX_CHAIN_MODELS, addToChain } from './model-chain'
import { initialModelChainsPanelState, modelChainsPanelReducer, type ModelChainsPanelState } from './model-chains-state'
import { defaultProductState, deriveAccountEntitlements } from '../../../billing/entitlements'
import { initialProviderPanelState } from '../../../sessions/provider-state'

/**
 * Default Free LoopLink chains: fresh Brain/Heart start pre-filled
 * with the best-5 Free models each (configuration only — no routing).
 * Runs behavior directly plus repository source for the architectural
 * invariants.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

const EXPECTED_BRAIN = [
  'builtin:gpt-5.6-luna',
  'builtin:deepseek-v4.1-flash',
  'builtin:gemini-2.5-flash',
  'builtin:claude-haiku-5.5',
  'builtin:glm-5.3-flash'
]

const EXPECTED_HEART = [
  'builtin:kimi-k2.7-code',
  'builtin:gpt-5.6-luna',
  'builtin:deepseek-v4.1-flash',
  'builtin:mimo-v2.6-pro',
  'builtin:muse-spark-1.3'
]

describe('default free chains', () => {
  it('fresh Brain defaults to exactly the five ordered models', () => {
    assert.deepEqual(createDefaultFreeBrainChain(), EXPECTED_BRAIN)
  })

  it('fresh Heart defaults to exactly the five ordered models', () => {
    assert.deepEqual(createDefaultFreeHeartChain(), EXPECTED_HEART)
  })

  it('every default id resolves to an existing Free builtin entry (no phantoms, no paid)', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const library = deriveModelLibrary(initialProviderPanelState())
    const ids = new Set(library.map((entry) => entry.stableId))
    for (const stableId of [...createDefaultFreeBrainChain(), ...createDefaultFreeHeartChain()]) {
      assert.ok(ids.has(stableId), `${stableId} must exist in the library`)
      const entry = library.find((candidate) => candidate.stableId === stableId)
      assert.equal(entry?.origin, 'built-in', `${stableId} must be a Free builtin`)
      assert.equal(entry?.locked, false, `${stableId} must not be locked`)
    }
  })

  it('no same-chain duplicate exists; cross-chain duplicates are allowed', () => {
    const brain = createDefaultFreeBrainChain()
    const heart = createDefaultFreeHeartChain()
    assert.equal(new Set(brain).size, brain.length, 'brain must hold no duplicate')
    assert.equal(new Set(heart).size, heart.length, 'heart must hold no duplicate')
    const shared = brain.filter((id) => heart.includes(id))
    assert.deepEqual(shared, ['builtin:gpt-5.6-luna', 'builtin:deepseek-v4.1-flash'])
  })

  it('Free chains start full at 5/5 (add control correctly reports full)', () => {
    assert.equal(MAX_CHAIN_MODELS, 5)
    assert.equal(createDefaultFreeBrainChain().length, MAX_CHAIN_MODELS)
    assert.equal(createDefaultFreeHeartChain().length, MAX_CHAIN_MODELS)
    for (const chain of [createDefaultFreeBrainChain(), createDefaultFreeHeartChain()]) {
      const outcome = addToChain(chain, stableModelId('builtin', 'mistral-large-4'))
      assert.equal(outcome.applied, false)
      assert.equal(outcome.reason, 'chain-full')
    }
  })

  it('fresh panel state carries the defaults', () => {
    const state = initialModelChainsPanelState()
    assert.deepEqual(state.brain, EXPECTED_BRAIN)
    assert.deepEqual(state.heart, EXPECTED_HEART)
  })

  it('user reorder and removal survive normal state updates (never reset to defaults)', () => {
    let state: ModelChainsPanelState = { ...initialModelChainsPanelState(), workspaceId: 7 }
    const moved = state.brain[state.brain.length - 1]
    assert.ok(moved !== undefined)
    state = modelChainsPanelReducer(state, {
      type: 'chain-move',
      workspaceId: 7,
      chain: 'brain',
      stableId: moved,
      direction: 'left'
    })
    assert.equal(state.brain[state.brain.length - 2], moved)
    const dropped = state.heart[0]
    assert.ok(dropped !== undefined)
    state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'heart', stableId: dropped })
    assert.equal(state.heart.length, 4)
    assert.ok(!state.heart.includes(dropped))
  })

  it('existing customized state is never replaced by defaults', () => {
    let state: ModelChainsPanelState = { ...initialModelChainsPanelState(), workspaceId: 7 }
    state = modelChainsPanelReducer(state, {
      type: 'chain-remove',
      workspaceId: 7,
      chain: 'brain',
      stableId: 'builtin:gpt-5.6-luna'
    })
    // A later unrelated update must not restore the removed default.
    state = modelChainsPanelReducer(state, {
      type: 'chain-move',
      workspaceId: 7,
      chain: 'heart',
      stableId: 'builtin:kimi-k2.7-code',
      direction: 'right'
    })
    assert.ok(!state.brain.includes('builtin:gpt-5.6-luna'))
    assert.equal(state.brain.length, 4)
  })

  it('higher entitlement limits still remain 10/15/25', () => {
    const free = deriveAccountEntitlements(defaultProductState())
    assert.equal(free.maxBrainModels, 5)
    assert.equal(free.maxHeartModels, 5)
    const magma = deriveAccountEntitlements({ ...defaultProductState(), basePlan: 'magma' })
    assert.equal(magma.maxBrainModels, 10)
    const frost = deriveAccountEntitlements({ ...defaultProductState(), basePlan: 'frost' })
    assert.equal(frost.maxBrainModels, 15)
    const fundedVoid = deriveAccountEntitlements({
      basePlan: 'free',
      voidWallet: { activatedEver: true, balanceMicros: 5000000 }
    })
    assert.equal(fundedVoid.maxBrainModels, 25)
  })

  it('Models V2 remains configuration-only with the non-routing copy intact', () => {
    const page = readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', 'ModelsSettings.tsx')
    assert.ok(page.includes('does not route'), 'honesty copy must survive the defaults pass')
    const brain = readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', 'models', 'BrainChain.tsx')
    const heart = readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', 'models', 'HeartChain.tsx')
    for (const [name, source] of [['BrainChain', brain], ['HeartChain', heart]] as const) {
      assert.ok(!source.includes('generateText'), `${name} must not call inference`)
      assert.ok(!source.includes('ProviderRegistry'), `${name} must not touch the provider runtime`)
    }
  })

  it('no provider runtime change occurred for this configuration pass', () => {
    const services = readSource('src', 'main', 'application', 'create-services.ts')
    const registrations = services.match(/registry\.register\(/g) ?? []
    assert.equal(registrations.length, 1, 'exactly one provider adapter stays registered (OpenAI)')
  })
})
