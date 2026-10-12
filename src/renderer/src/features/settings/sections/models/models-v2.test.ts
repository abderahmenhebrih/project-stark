import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Settings → Models V2 structural proof: visual Model Library cards
 * with honest metadata, grid-native Add model card, exactly the three
 * Add choices, independent Brain/Heart LoopLink configuration, and no
 * fabricated providers, backends, or pricing. Runs against repository
 * source (cwd is the repo root via npm).
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

describe('models V2 library', () => {
  it('uses rectangular cards in a responsive grid with Add last', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('<ModelCard'), 'library must render model cards')
    assert.ok(page.includes('models-grid'), 'cards must live in a grid')
    assert.ok(page.includes('<AddModelCard'), 'grid must end with an Add model card')
    assert.ok(page.indexOf('<ModelCard') < page.indexOf('<AddModelCard'), 'Add model card must be last')
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(card.includes('modelIconFor'), 'card must carry the mapped model icon')
    assert.ok(card.includes('displayName'), 'card must show the model name')
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(library.includes('BUILT_IN_DEFINITIONS'), 'catalog must define the Free entries')
    const add = codeOnly(readModels('models/AddModelCard.tsx'))
    assert.ok(add.includes('Add model'), 'add card must be labelled Add model')
    assert.ok(add.includes('models-card'), 'add card must share card dimensions')
    assert.ok(add.includes('<button'), 'add card must be keyboard accessible')
  })

  it('shows honest empty state and only real configured models', () => {
    const page = readModels('ModelsSettings.tsx')
    assert.ok(page.includes('No models added yet.'), 'empty library must say so plainly')
    assert.ok(page.includes('deriveModelLibrary'), 'library must derive from provider source truth')
    const library = codeOnly(readModels('models/model-library.ts'))
    assert.ok(library.includes('if (provider.configured)'), 'user entries must require configuration')
    for (const fake of ['128K', '200K', '1M tokens']) {
      assert.ok(!library.includes(fake), `library must not fabricate ${fake}`)
    }
  })

  it('Add model opens exactly three primary choices', () => {
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    for (const choice of ['Add API key', 'Link a local model', 'Upgrade your plan']) {
      assert.ok(flow.includes(choice), `flow must offer ${choice}`)
    }
    const setters = flow.match(/setChoice\('(?:api-key|local|upgrade)'\)/g) ?? []
    assert.equal(setters.length, 3)
  })

  it('offers only the locked Free families (no fabricated providers)', () => {
    for (const file of [
      'ModelsSettings.tsx',
      'models/model-library.ts',
      'models/AddModelFlow.tsx',
      'models/ModelCard.tsx'
    ]) {
      const source = codeOnly(readModels(file))
      for (const fake of ['Llama', 'Ollama', 'LM Studio', 'localhost', '127.0.0.1']) {
        assert.ok(!source.includes(fake), `${file} must not fabricate ${fake}`)
      }
    }
    // Provider metadata is catalog identity for the 15 locked Free
    // entries only — never inference routing, endpoints, or SDKs.
    const library = codeOnly(readModels('models/model-library.ts'))
    for (const fake of ['generateText', 'testConnection', 'listModels', 'https://', 'http://']) {
      assert.ok(!library.includes(fake), `model-library must not contain ${fake}`)
    }
  })

  it('Free cards carry no Preview warning and no token-limit placeholder', () => {
    for (const file of ['models/ModelCard.tsx', 'models/model-library.ts']) {
      const source = codeOnly(readModels(file))
      assert.ok(!source.includes('Preview — unavailable in this build'), `${file} must not mark Free models Preview`)
      assert.ok(!source.includes('Token limit unavailable'), `${file} must not render the token placeholder`)
    }
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(card.includes('aria-pressed'), 'selectable cards must expose pressed state')
    assert.ok(card.includes('select model'), 'selectable cards must name the select action')
  })

  it('local linking is an honest placeholder with no fake backend', () => {
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    assert.ok(flow.includes('Local model linking is not available yet.'), 'local path must be honest')
    for (const fake of ['Ollama', 'LM Studio', 'localhost', '127.0.0.1']) {
      assert.ok(!flow.includes(fake), `local path must not fake ${fake}`)
    }
  })

  it('upgrade path has no pricing, plans, or billing runtime', () => {
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    assert.ok(
      flow.includes('Additional hosted models will become available with STARK plans.'),
      'upgrade must stay honest'
    )
    assert.ok(flow.includes('View billing'), 'upgrade must offer local Billing navigation')
    assert.ok(flow.includes('onNavigateBilling'), 'Billing navigation must be a local section change')
    for (const fake of ['Stripe', 'checkout', 'invoice', 'price', 'Price', '$']) {
      assert.ok(!flow.includes(fake), `upgrade path must not contain ${fake}`)
    }
  })
})

describe('models V2 brain and heart chains', () => {
  it('renders two independent chains sharing one component', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('<BrainChain'), 'page must render the Brain Chain')
    assert.ok(page.includes('<HeartChain'), 'page must render the Heart Chain')
    const brain = codeOnly(readModels('models/BrainChain.tsx'))
    const heart = codeOnly(readModels('models/HeartChain.tsx'))
    assert.ok(brain.includes('<ModelChain'), 'brain must share the chain component')
    assert.ok(heart.includes('<ModelChain'), 'heart must share the chain component')
    assert.ok(brain.includes('kind="brain"'), 'brain must identify itself')
    assert.ok(heart.includes('kind="heart"'), 'heart must identify itself')
  })

  it('reads as an ordered LoopLink roster with toggles and keyboard controls', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(chain.includes('LoopLink'), 'chain must carry the LoopLink indicator')
    assert.ok(chain.includes('Position'), 'positions must be exposed')
    assert.ok(chain.includes('role="switch"'), 'each row must offer an enable switch')
    assert.ok(chain.includes('Reorder'), 'each enabled row must offer reorder')
    assert.ok(chain.includes('aria-label'), 'chain controls must be labelled')
  })

  it('routes inference through the chains in order', () => {
    const page = readModels('ModelsSettings.tsx')
    assert.ok(
      page.includes('Routing active'),
      'page must state routing is active'
    )
    assert.ok(
      !page.includes('STARK does not route inference through them yet.'),
      'old non-routing copy must be gone'
    )
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(
      chain.includes('Routing active'),
      'each LoopLink must carry the active routing line'
    )
    assert.ok(
      !chain.includes('LoopLink routing is not enabled in this build.'),
      'old fake note must be gone'
    )
    for (const file of ['models/ModelChain.tsx', 'models/model-chain.ts', 'models/model-chains-state.ts']) {
      const source = codeOnly(readModels(file))
      for (const fake of ['generateText', 'testConnection', 'listModels']) {
        assert.ok(!source.includes(fake), `${file} must not call provider execution`)
      }
    }
  })

  it('unavailable models keep their position instead of dangling', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(chain.includes('Unavailable'), 'missing ids must render Unavailable')
  })
})

describe('models V2 no-regression surface', () => {
  it('adds no IPC, network, or storage surface', () => {
    for (const file of [
      'ModelsSettings.tsx',
      'models/ModelCard.tsx',
      'models/AddModelCard.tsx',
      'models/AddModelFlow.tsx',
      'models/ModelChain.tsx',
      'models/BrainChain.tsx',
      'models/HeartChain.tsx',
      'models/model-library.ts',
      'models/model-chain.ts',
      'models/model-chains-state.ts'
    ]) {
      const source = codeOnly(readModels(file))
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('fetch('), `${file} must make no network requests`)
    }
  })

  it('chain state carries no secrets, migrations, or database access', () => {
    for (const file of ['models/model-chain.ts', 'models/model-chains-state.ts', 'models/model-library.ts']) {
      const source = codeOnly(readModels(file))
      for (const forbidden of ['migration', 'sqlite', 'BLOB', 'apiKey', 'secret']) {
        assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
      }
    }
  })
})
