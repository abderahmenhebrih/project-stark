import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { initialProviderPanelState } from '../../../sessions/provider-state'
import {
  NO_ENTITLEMENTS,
  canEnterChain,
  canUseModel,
  deriveModelLibrary,
  findLibraryModel,
  isPlanEntitled,
  stableModelId,
  tokenSessionLabel
} from './model-library'

function configuredProvider(models: readonly string[], selectedModel: string | null) {
  return {
    ...initialProviderPanelState(),
    workspaceId: 3,
    configured: true,
    selectedModel,
    models: models.map((id) => ({ id }))
  }
}

function unconfiguredProvider() {
  return { ...initialProviderPanelState(), workspaceId: 3 }
}

describe('model library identity', () => {
  it('shows built-in and locked plan models without API setup (no user models)', () => {
    const library = deriveModelLibrary(unconfiguredProvider())
    assert.deepEqual(
      library.map((entry) => entry.origin),
      ['built-in', 'plan']
    )
  })

  it('derives user models from discovery plus the selected model', () => {
    const library = deriveModelLibrary(configuredProvider(['gpt-4o', 'o3-mini'], 'gpt-4o'))
    const user = library.filter((entry) => entry.origin === 'api')
    assert.deepEqual(
      user.map((entry) => entry.model),
      ['gpt-4o', 'o3-mini']
    )
    for (const entry of user) {
      assert.equal(entry.providerId, 'openai')
      assert.equal(entry.sourceType, 'remote')
      assert.equal(entry.available, true)
      assert.equal(entry.locked, false)
      assert.equal(entry.badge, 'API')
      assert.equal(entry.stableId, stableModelId('openai', entry.model))
      assert.equal(entry.displayName, entry.model)
    }
  })

  it('orders built-in before user-added before plan', () => {
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4o'))
    assert.deepEqual(
      library.map((entry) => entry.origin),
      ['built-in', 'api', 'plan']
    )
  })

  it('keeps the selected model when discovery is stale or empty', () => {
    const library = deriveModelLibrary(configuredProvider([], 'gpt-4o'))
    assert.deepEqual(
      library.filter((entry) => entry.origin === 'api').map((entry) => entry.model),
      ['gpt-4o']
    )
  })

  it('dedupes discovery against the selected model with stable order', () => {
    const library = deriveModelLibrary(configuredProvider(['b-model', 'a-model'], 'a-model'))
    assert.deepEqual(
      library.filter((entry) => entry.origin === 'api').map((entry) => entry.model),
      ['a-model', 'b-model']
    )
  })

  it('reports honest token metadata instead of fabricating limits', () => {
    assert.equal(tokenSessionLabel(), 'Token limit unavailable')
  })

  it('finds entries by stable id', () => {
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4o'))
    const id = stableModelId('openai', 'gpt-4o')
    assert.equal(findLibraryModel(library, id)?.model, 'gpt-4o')
    assert.equal(findLibraryModel(library, 'openai:missing'), undefined)
  })

  it('unlocks the same plan identity through entitlements', () => {
    const locked = deriveModelLibrary(unconfiguredProvider(), NO_ENTITLEMENTS).find(
      (entry) => entry.origin === 'plan'
    )
    assert.ok(locked !== undefined)
    assert.equal(locked.locked, true)
    assert.equal(canUseModel(locked), false)
    assert.equal(canEnterChain(locked), false)
    const entitlements = { planModels: [locked.stableId] as readonly string[] }
    assert.equal(isPlanEntitled(locked.stableId, entitlements), true)
    const unlocked = deriveModelLibrary(unconfiguredProvider(), entitlements).find(
      (entry) => entry.origin === 'plan'
    )
    assert.ok(unlocked !== undefined)
    assert.equal(unlocked.stableId, locked.stableId)
    assert.equal(unlocked.locked, false)
    assert.equal(canUseModel(unlocked, entitlements), true)
    assert.equal(canEnterChain(unlocked, entitlements), true)
  })

  it('stores no credential material in catalog entries', () => {
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4o'))
    for (const entry of library) {
      for (const key of Object.keys(entry)) {
        for (const forbidden of ['apiKey', 'secret', 'password', 'credential', 'token']) {
          assert.ok(!key.toLowerCase().includes(forbidden), `catalog entry must not carry ${forbidden}`)
        }
      }
      const serialized = JSON.stringify(entry)
      assert.ok(!serialized.includes('sk-'), 'catalog entry must not carry key material')
    }
  })
})
