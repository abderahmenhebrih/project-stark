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
  it('shows the 15 STARK Free built-ins without API setup (no paid catalog yet)', () => {
    const library = deriveModelLibrary(unconfiguredProvider())
    assert.equal(library.length, 15)
    assert.ok(library.every((entry) => entry.origin === 'built-in'))
    assert.ok(library.every((entry) => entry.available && !entry.locked))
    assert.ok(library.every((entry) => entry.badge === 'FREE'))
    assert.ok(!library.some((entry) => entry.origin === 'plan'), 'no paid catalog before Billing')
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

  it('orders built-in Free catalog before user-added models', () => {
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4o'))
    assert.deepEqual(
      library.map((entry) => entry.origin),
      [...Array<string>(15).fill('built-in'), 'api']
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

  it('preserves the plan entitlement seam without a paid catalog yet', () => {
    // No paid catalog is derived before Billing defines it, but the
    // origin/lock/entitlement architecture stays intact for synthetic
    // plan entries (the shape Billing will later derive).
    assert.deepEqual(
      deriveModelLibrary(unconfiguredProvider(), NO_ENTITLEMENTS).filter(
        (entry) => entry.origin === 'plan'
      ),
      []
    )
    const locked = {
      stableId: 'plan:future-model',
      providerId: 'plan',
      providerLabel: 'Plan',
      model: 'future-model',
      displayName: 'Future Plan Model',
      sourceType: 'remote' as const,
      origin: 'plan' as const,
      available: false,
      locked: true,
      badge: 'Pro',
      planRequirement: 'STARK plan'
    }
    assert.equal(canUseModel(locked), false)
    assert.equal(canEnterChain(locked), false)
    const entitlements = { planModels: [locked.stableId] as readonly string[] }
    assert.equal(isPlanEntitled(locked.stableId, entitlements), true)
    assert.equal(isPlanEntitled('plan:other', entitlements), false)
    const unlocked = { ...locked, available: true, locked: false }
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
