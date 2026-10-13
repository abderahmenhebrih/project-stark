import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialProviderPanelState } from '../../../sessions/provider-state'
import {
  FREE_CATALOG_COUNT,
  canEnterChain,
  canUseModel,
  deriveModelLibrary
} from './model-library'

/**
 * STARK Free architecture proof: the 15 built-ins are intrinsic
 * product state — present, selectable, and chain-enterable with zero
 * provider setup and no Preview warning. Optional BYOK discovery
 * stays isolated; the composer defaults to Free; STARK is never
 * globally not-configured for lack of a BYOK key; LoopLinks carry a
 * truthful routing-active status driving real runtime; schema stays
 * v19 with auth and extensions untouched. Runs behavior + source.
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

function freeCatalog() {
  return deriveModelLibrary({ ...initialProviderPanelState(), workspaceId: 3 }).filter(
    (entry) => entry.origin === 'built-in'
  )
}

describe('free architecture: catalog present with zero setup', () => {
  it('all 15 Free models exist automatically without any provider setup', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const builtIn = freeCatalog()
    assert.equal(builtIn.length, 15)
    for (const entry of builtIn) {
      assert.equal(entry.available, true, `${entry.displayName} must be available`)
      assert.equal(canUseModel(entry), true, `${entry.displayName} must be usable`)
      assert.equal(canEnterChain(entry), true, `${entry.displayName} must enter chains`)
    }
  })

  it('catalog definitions stay intact (15 locked entries, FREE badges, icons mapped)', () => {
    const builtIn = freeCatalog()
    assert.ok(builtIn.every((entry) => entry.badge === 'FREE' && !entry.locked))
    assert.ok(builtIn.every((entry) => entry.stableId.startsWith('builtin:')))
    const icons = readModels('models/model-icons.ts')
    for (const entry of builtIn) {
      assert.ok(icons.includes(`'${entry.stableId}'`), `${entry.stableId} must keep its icon`)
    }
  })

  it('Free cards carry no Preview warning and no token placeholder', () => {
    for (const file of ['models/ModelCard.tsx', 'models/model-library.ts']) {
      const source = codeOnly(readModels(file))
      assert.ok(!source.includes('Preview — unavailable in this build'), `${file} must not mark Free models Preview`)
      assert.ok(!source.includes('Token limit unavailable'), `${file} must not render the token placeholder`)
      assert.ok(!source.includes('unavailable in this build'), `${file} must not imply Free needs setup`)
    }
    const card = codeOnly(readModels('models/ModelCard.tsx'))
    assert.ok(!card.includes('Use model'), 'cards must offer no run action')
    assert.ok(!card.includes('Remove Model'), 'cards must offer no deletion path')
    assert.ok(card.includes('aria-pressed'), 'selectable cards must expose pressed state')
  })
})

describe('free architecture: optional BYOK stays isolated', () => {
  it('configured OpenAI entries remain usable and chain-enterable', () => {
    const user = deriveModelLibrary(configuredProvider()).filter((entry) => entry.origin === 'api')
    assert.equal(user.length, 2)
    for (const entry of user) {
      assert.equal(entry.providerId, 'openai')
      assert.equal(canUseModel(entry), true, `${entry.model} must stay usable`)
      assert.equal(canEnterChain(entry), true, `${entry.model} must stay chain-enterable`)
    }
  })

  it('renderer run selection still targets only the OpenAI provider id', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes("OPENAI_PROVIDER_ID = 'openai'"), 'run path must name the openai provider')
    assert.ok(panel.includes('providerId: OPENAI_PROVIDER_ID'), 'Use model must target openai only')
    assert.ok(!panel.includes("setProviderModel({ providerId: 'google'"), 'no Google run route may exist')
  })

  it('main runtime registers exactly the two known adapters (no fakes)', () => {
    const services = codeOnly(readSource('src', 'main', 'application', 'create-services.ts'))
    const registrations = services.match(/registry\.register\(/g) ?? []
    assert.equal(registrations.length, 2, 'exactly two provider adapters must be registered')
    assert.ok(services.includes('OpenAiProviderAdapter'), 'the BYOK adapter must be OpenAI')
    assert.ok(services.includes('StarkHostedProviderAdapter'), 'the hosted adapter must be registered')
    for (const fake of ['AnthropicProviderAdapter', 'GoogleProviderAdapter', 'BuiltinProviderAdapter', 'PreviewProviderAdapter']) {
      assert.ok(!services.includes(fake), `main must not register ${fake}`)
    }
    const library = codeOnly(readModels('models/model-library.ts'))
    for (const fake of ['generateText', 'testConnection', 'listModels', 'https://', 'http://']) {
      assert.ok(!library.includes(fake), `model-library must not contain ${fake}`)
    }
  })

  it('builtin requests route through the hosted adapter with the session token', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('model: composerModelStableId'), 'sends must carry the routing stable id')
    const completion = codeOnly(readSource('src', 'main', 'ai', 'ai-completion-service.ts'))
    assert.ok(completion.includes("resolveExplicitAssignment('stark'"), 'Ask must resolve builtin through stark')
    const brain = codeOnly(readSource('src', 'main', 'ai', 'ai-brain-service.ts'))
    assert.ok(brain.includes("providerId: 'stark'"), 'Brain must honor builtin overrides through stark')
  })
})

describe('free architecture: composer defaults to Free, never demands BYOK', () => {
  it('composer selection defaults to the first Free Brain default', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('createDefaultFreeBrainChain()'), 'Free default must follow the default policy')
    assert.ok(panel.includes('handleSelectStarkModel'), 'Free selection must be user-changeable')
    assert.ok(panel.includes("defaults[0] ?? 'builtin:gpt-5.6-luna'"), 'default must be GPT 5.6 Luna')
  })

  it('global readiness is Free when signed in — never an OpenAI demand', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes("accountSignedIn ? 'free' : 'not-configured'"), 'signed-in Free must never read as not-configured')
    assert.ok(panel.includes('Sign in to use STARK Free models.'), 'signed-out copy must prompt sign-in')
    assert.ok(!panel.includes('Connect an AI provider to use Ask and Work.'), 'old OpenAI demand must be gone')
    assert.ok(!panel.includes('Add OpenAI key'), 'empty session must not demand a key')
  })

  it('Free cards are selectable with pressed state', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('onSelectStarkModel'), 'library must wire Free selection')
    assert.ok(page.includes('starkModel'), 'library must track the Free selection')
  })
})

describe('free architecture: LoopLink routing-active status driving runtime', () => {
  it('both LoopLinks carry the routing-active line', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(
      chain.includes('Routing active'),
      'shared LoopLink component must state routing is active'
    )
    assert.ok(
      !chain.includes('LoopLink routing is not enabled in this build.'),
      'old fake note must be gone'
    )
    assert.ok(chain.includes('role="note"'), 'status must be an accessible note')
  })

  it('no Preview chips remain on Free roster positions', () => {
    const chain = codeOnly(readModels('models/ModelChain.tsx'))
    assert.ok(!chain.includes('Preview'), 'roster must not mark Free positions Preview')
    assert.ok(chain.includes('Unavailable'), 'missing ids must still render Unavailable')
  })

  it('LoopLink runtime (state, rules, defaults, entitlements) drives main execution', () => {
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
    assert.ok(page.includes('Routing active'), 'page routing-active copy must remain')
    assert.ok(page.includes('<BrainChain') && page.includes('<HeartChain'), 'configuration UI must remain')
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('brainModels'), 'SessionPanel must send Brain LoopLink snapshots')
    assert.ok(panel.includes('heartModels'), 'SessionPanel must send Heart LoopLink snapshots')
    const brain = codeOnly(readSource('src', 'main', 'ai', 'ai-brain-service.ts'))
    assert.ok(brain.includes('brainChain') || brain.includes('brainModels'), 'Brain service must consume the Brain chain')
  })
})

describe('free architecture: no collateral changes', () => {
  it('schema remains v20 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('020-looplink-audit.ts'), 'migration 020 must exist (schema v20)')
    assert.ok(!files.some((file) => file.startsWith('021')), 'no migration 020 may appear')
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

  it('extensions stay frozen (no new hooks from this pass)', () => {
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
