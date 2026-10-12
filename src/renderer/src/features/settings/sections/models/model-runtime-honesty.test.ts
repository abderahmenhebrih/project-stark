import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialProviderPanelState } from '../../../sessions/provider-state'
import {
  FREE_CATALOG_COUNT,
  canEnterChain,
  canUseModel,
  deriveModelLibrary,
  hasRuntimeRoute
} from './model-library'

/**
 * Demo honesty guard: only models with a proven registered runtime
 * route may be selected for an AI run. The 15 Free built-ins are
 * catalog preview cards (visible, never runnable, never
 * chain-enterable); the configured OpenAI route keeps working; no
 * fake provider is registered; LoopLinks carry a truthful
 * non-routing status with runtime untouched; schema stays v19 with
 * auth and extensions untouched. Runs behavior + repository source.
 */

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readModels(relative: string): string {
  return readSource('src', 'renderer', 'src', 'features', 'settings', 'sections', ...relative.split('/'))
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function configuredProvider() {
  return {
    ...initialProviderPanelState(),
    workspaceId: 3,
    configured: true,
    selectedModel: 'gpt-4o',
    models: [{ id: 'gpt-4o' }, { id: 'o3-mini' }]
  }
}

describe('demo honesty: unrouted models cannot run', () => {
  it('all 15 built-in preview cards are unrunnable and never chain-enterable', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const builtIn = deriveModelLibrary({ ...initialProviderPanelState(), workspaceId: 3 }).filter(
      (entry) => entry.origin === 'built-in'
    )
    assert.equal(builtIn.length, 15)
    for (const entry of builtIn) {
      assert.equal(hasRuntimeRoute(entry), false, `${entry.displayName} must have no runtime route`)
      assert.equal(canUseModel(entry), false, `${entry.displayName} must not be usable for a run`)
      assert.equal(canEnterChain(entry), false, `${entry.displayName} must not enter a chain`)
    }
  })

  it('catalog definitions stay intact (15 locked entries, FREE badges, icons mapped)', () => {
    const builtIn = deriveModelLibrary({ ...initialProviderPanelState(), workspaceId: 3 }).filter(
      (entry) => entry.origin === 'built-in'
    )
    assert.ok(builtIn.every((entry) => entry.badge === 'FREE' && !entry.locked))
    assert.ok(builtIn.every((entry) => entry.stableId.startsWith('builtin:')))
    const icons = readModels('models/model-icons.ts')
    for (const entry of builtIn) {
      assert.ok(icons.includes(`'${entry.stableId}'`), `${entry.stableId} must keep its icon`)
    }
  })

  it('preview cards render the honest status with no run action', () => {
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(card.includes('Preview — unavailable in this build'), 'preview status copy must exist')
    assert.ok(!card.includes('Use model'), 'cards must offer no run action')
    assert.ok(!card.includes('Remove Model'), 'cards must offer no deletion path')
  })
})

describe('demo honesty: routed OpenAI model still works', () => {
  it('configured OpenAI entries are runnable and chain-enterable', () => {
    const user = deriveModelLibrary(configuredProvider()).filter((entry) => entry.origin === 'api')
    assert.equal(user.length, 2)
    for (const entry of user) {
      assert.equal(entry.providerId, 'openai')
      assert.equal(hasRuntimeRoute(entry), true, `${entry.model} must hold the proven route`)
      assert.equal(canUseModel(entry), true, `${entry.model} must stay usable`)
      assert.equal(canEnterChain(entry), true, `${entry.model} must stay chain-enterable`)
    }
  })

  it('renderer run selection targets only the OpenAI provider id', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes("OPENAI_PROVIDER_ID = 'openai'"), 'run path must name the openai provider')
    assert.ok(panel.includes('providerId: OPENAI_PROVIDER_ID'), 'Use model must target openai only')
    assert.ok(!panel.includes("setProviderModel({ providerId: 'google'"), 'no Google run route may exist')
    assert.ok(!panel.includes("setProviderModel({ providerId: 'builtin'"), 'no builtin run route may exist')
  })

  it('main runtime still requires the proven openai route', () => {
    const completion = codeOnly(readSource('src', 'main', 'ai', 'ai-completion-service.ts'))
    assert.ok(completion.includes("requireProvider('openai')"), 'Ask must require the openai route')
    const brain = codeOnly(readSource('src', 'main', 'ai', 'ai-brain-service.ts'))
    assert.ok(!brain.includes('builtin:'), 'Brain must never resolve catalog preview ids')
  })

  it('no fake provider registration was added', () => {
    const types = codeOnly(readSource('src', 'shared', 'providers', 'types.ts'))
    assert.ok(types.includes("'openai'"), 'openai provider id must remain')
    const services = codeOnly(readSource('src', 'main', 'application', 'create-services.ts'))
    const registrations = services.match(/registry\.register\(/g) ?? []
    assert.equal(registrations.length, 1, 'exactly one provider adapter must be registered')
    assert.ok(services.includes('OpenAiProviderAdapter'), 'the registered adapter must be OpenAI')
    for (const fake of ['AnthropicProviderAdapter', 'GoogleProviderAdapter', 'BuiltinProviderAdapter', 'PreviewProviderAdapter']) {
      assert.ok(!services.includes(fake), `main must not register ${fake}`)
    }
    const library = codeOnly(readModels('models/model-library.ts'))
    for (const fake of ['generateText', 'testConnection', 'listModels', 'https://', 'http://']) {
      assert.ok(!library.includes(fake), `model-library must not contain ${fake}`)
    }
  })
})

describe('demo honesty: LoopLink non-routing status with runtime untouched', () => {
  it('both LoopLinks carry the restrained non-routing line', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(
      chain.includes('LoopLink routing is not enabled in this build.'),
      'shared LoopLink component must state routing is off'
    )
    assert.ok(chain.includes('role="note"'), 'status must be an accessible note')
  })

  it('retained preview positions render as Preview, never as live', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(chain.includes('canUseModel(row.entry)'), 'enabled rows must check runnability')
    assert.ok(chain.includes('Preview'), 'non-runnable actives must be marked Preview')
    assert.ok(chain.includes('Unavailable'), 'missing ids must still render Unavailable')
  })

  it('LoopLink runtime (state, rules, defaults, entitlements) is untouched', () => {
    for (const file of ['models/model-chain.ts', 'models/model-chains-state.ts']) {
      const source = codeOnly(readModels(file))
      for (const fake of ['generateText', 'testConnection', 'listModels', '.invoke(', 'fetch(']) {
        assert.ok(!source.includes(fake), `${file} must not call execution or IPC`)
      }
    }
    const state = codeOnly(readModels('models/model-chains-state.ts'))
    assert.ok(state.includes('createDefaultFreeBrainChain()'), 'brain defaults must remain')
    assert.ok(state.includes('createDefaultFreeHeartChain()'), 'heart defaults must remain')
    const page = readModels('ModelsSettings.tsx')
    assert.ok(page.includes('STARK does not route inference through them yet.'), 'page honesty copy must remain')
    assert.ok(page.includes('<BrainChain') && page.includes('<HeartChain'), 'configuration UI must remain')
  })
})

describe('demo honesty: no collateral changes', () => {
  it('schema remains v19 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })

  it('auth surface is untouched (Google/GitHub, plan, sign out; no second identity)', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Continue with Google'), 'Google sign-in must remain')
    assert.ok(panel.includes('Continue with GitHub'), 'GitHub sign-in must remain')
    assert.ok(panel.includes('Sign out'), 'sign out must remain')
    assert.ok(panel.includes('Current plan: STARK Free'), 'plan line must remain')
    const account = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!account.includes('Local Profile'), 'no second identity may return')
    assert.ok(account.includes('View Billing'), 'billing route must remain')
  })

  it('extensions stay frozen (no new hooks from the honesty pass)', () => {
    assert.ok(
      existsSync(
        join(process.cwd(), 'src', 'main', 'extension-host', 'extension-activation-service.ts')
      ),
      'extension host must remain'
    )
    for (const file of [
      'ModelsSettings.tsx',
      'models/ModelCard.tsx',
      'models/ModelChain.tsx',
      'models/model-library.ts',
      'models/model-chain.ts',
      'models/model-chains-state.ts'
    ]) {
      const source = codeOnly(readModels(file))
      assert.ok(!source.includes('listExtensionAgentProviders'), `${file} must not touch extensions`)
      assert.ok(!source.includes('registerExtension'), `${file} must not register extensions`)
    }
  })
})
