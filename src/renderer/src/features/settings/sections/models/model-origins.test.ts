import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Model origin classes structural proof: built-in entries appear
 * automatically and are never deletable, user entries stay
 * distinguishable, plan entries are visible while locked and refuse
 * chain insertion with a Billing route, the Add card stays last, and
 *   chains start with the Free defaults. Runs against repository source.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

/** Source with line/block comments removed, so assertions test code — not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('model origin classes', () => {
  it('built-in models appear automatically without API setup', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('deriveModelLibrary'), 'library must derive from the catalog')
    assert.ok(page.includes('STARK Free'), 'built-in group must be labelled')
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(library.includes('BUILT_IN_DEFINITIONS'), 'a built-in catalog must exist')
    assert.ok(library.includes("origin: 'built-in'"), 'built-in entries must carry their origin')
  })

  it('built-in entries are never deletable from the library', () => {
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(!card.includes('Remove'), 'cards must offer no destructive remove action')
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(!library.includes('deleteModel'), 'catalog must offer no deletion path')
    assert.ok(!library.includes('removeModel'), 'catalog must offer no removal path')
  })

  it('user-added models stay distinguishable from built-in', () => {
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(library.includes("origin: 'api'"), 'key-added models must carry the api origin')
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('Connected providers'), 'page source must label the discovered group')
  })

  it('plan models are visible while locked with an upgrade route', () => {
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(library.includes("origin: 'plan'"), 'plan entries must carry their origin')
    assert.ok(library.includes('locked: !entitled'), 'lock must derive from entitlements')
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(card.includes('Upgrade your plan'), 'locked cards must offer the upgrade action')
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('onUpgrade={props.onNavigateBilling}'), 'locked cards must route to Billing')
    assert.ok(page.includes('Available with STARK plans'), 'plan group must be labelled')
  })

  it('locked plan models cannot enter either chain', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('canEnterChain'), 'insertion must pass the configuration-time guard')
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(chain.includes('canEnterChain'), 'picker must understand availability')
    assert.ok(chain.includes('locked'), 'locked entries must be marked in the picker')
  })

  it('the Add model card remains last after every group', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.indexOf('<AddModelCard') > page.lastIndexOf('<ModelCard'), 'Add model must follow all groups')
  })

  it('chains start with the Free defaults (presence drives routing)', () => {
    const state = codeOnly(readModels('models/model-chains-state.ts'))
    assert.ok(state.includes('createDefaultFreeBrainChain()'), 'brain must start with the Free defaults')
    assert.ok(state.includes('createDefaultFreeHeartChain()'), 'heart must start with the Free defaults')
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('Routing active'), 'defaults must keep the routing-active copy')
  })

  it('origin surfaces carry no pricing, backends, or secrets', () => {
    for (const file of [
      'ModelsSettings.tsx',
      'models/model-library.ts',
      'models/ModelCard.tsx',
      'models/ModelChain.tsx'
    ]) {
      const source = codeOnly(readModels(file))
      for (const fake of ['Stripe', 'checkout', 'invoice', 'per month', 'Ollama', 'LM Studio']) {
        assert.ok(!source.includes(fake), `${file} must not contain ${fake}`)
      }
    }
  })
})
