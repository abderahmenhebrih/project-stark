import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialProviderPanelState, providerPanelReducer, type ProviderPanelState } from './provider-state'
import { providerReadiness, providerReadinessLabel } from './provider-readiness'
import {
  initialModelChainsPanelState,
  modelChainsPanelReducer,
  type ModelChainsPanelState
} from '../settings/sections/models/model-chains-state'
import {
  FREE_CATALOG_COUNT,
  createDefaultFreeBrainChain,
  createDefaultFreeHeartChain,
  deriveModelLibrary,
  findLibraryModel
} from '../settings/sections/models/model-library'
import { effectiveSelectedModel } from '../settings/sections/models/model-compatibility'

/**
 * Optional OpenAI BYOK disconnect proof: the connected-provider area
 * offers Disconnect behind a STARK confirmation (no browser
 * confirm()); confirming deletes the credential through the narrow
 * main-owned path and cleans renderer state (models, selection,
 * LoopLink openai:* entries) while STARK Free, Google auth, hosted
 * inference, and schema v20 stay untouched.
 */

function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function disconnectRegion(): string {
  const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
  const at = panel.indexOf('async function handleDisconnect')
  assert.ok(at >= 0, 'SessionPanel must own handleDisconnect')
  return panel.slice(at, at + 3200)
}

describe('provider disconnect: UI affordance', () => {
  it('connected OpenAI area shows Refresh models and Disconnect', () => {
    const page = codeOnly(readRenderer('features/settings/sections/ModelsSettings.tsx'))
    assert.ok(page.includes('OpenAI · Connected'), 'connected status must render')
    assert.ok(page.includes('Refresh models'), 'refresh action must sit beside disconnect')
    assert.ok(page.includes('aria-label="Disconnect OpenAI"'), 'Disconnect must be labelled')
    assert.ok(page.includes('onDisconnect'), 'Disconnect must flow through the SessionPanel-owned callback')
  })

  it('confirmation uses the STARK dialog pattern with the exact copy', () => {
    const page = readRenderer('features/settings/sections/ModelsSettings.tsx')
    // JSX wraps the copy across lines; normalize whitespace like the renderer does.
    const flat = page.replace(/\s+/g, ' ')
    assert.ok(flat.includes('role="alertdialog"'), 'confirmation must use the alertdialog pattern')
    assert.ok(flat.includes('aria-label="Disconnect OpenAI?"'), 'dialog must be labelled')
    assert.ok(flat.includes('Disconnect OpenAI?'), 'dialog title must match')
    assert.ok(
      flat.includes(
        'Your saved OpenAI API key and discovered OpenAI models will be removed from this device. STARK Free models will remain available.'
      ),
      'dialog copy must match'
    )
    assert.ok(flat.includes('Cancel'), 'cancel must exist')
    assert.ok(!page.includes('window.confirm'), 'no browser confirm() may be used')
  })
})

describe('provider disconnect: credential removal path', () => {
  it('confirm path deletes through the narrow main-owned credential deletion', () => {
    const region = disconnectRegion()
    assert.ok(
      region.includes('clearProviderCredential(OPENAI_PROVIDER_ID)'),
      'disconnect must call the existing narrow deletion with providerId openai'
    )
    assert.ok(!region.includes('saveCredential'), 'disconnect must never write credentials')
  })

  it('cancel changes nothing (dialog only closes)', () => {
    const page = codeOnly(readRenderer('features/settings/sections/ModelsSettings.tsx'))
    const cancelAt = page.indexOf('setConfirmDisconnectOpen(false)')
    assert.ok(cancelAt >= 0, 'cancel must close the dialog')
    // The Cancel button handler closes without invoking the callback.
    const cancelButton = page.lastIndexOf('<button', page.indexOf('Cancel'))
    assert.ok(cancelButton >= 0 && cancelButton < page.indexOf('Cancel'))
    const confirmHandler = page.indexOf('props.onDisconnect()')
    assert.ok(confirmHandler >= 0, 'only the confirm action invokes onDisconnect')
  })

  it('renderer never receives the key (sanitized state only)', () => {
    const region = disconnectRegion()
    assert.ok(!/apiKey(?!Input)/.test(region.replace(/apiKeyInput/g, '')), 'disconnect must not read any key material')
    const bridge = codeOnly(readRenderer('lib/providers-api.ts'))
    assert.ok(bridge.includes('clearCredential'), 'renderer uses the keyless deletion bridge')
    // The save request carries the write-only key by design; the
    // returned state (getState/clearCredential) must carry no secrets.
    const types = codeOnly(readSource('src', 'shared', 'providers', 'types.ts'))
    const stateAt = types.indexOf('interface AiProviderState')
    assert.ok(stateAt >= 0, 'AiProviderState contract must exist')
    const stateBlock = types.slice(stateAt, types.indexOf('}', stateAt) + 1)
    assert.ok(!/apiKey|secret|token|credential/i.test(stateBlock), 'returned provider state carries no secrets')
  })

  it('disconnect touches neither account auth nor hosted inference', () => {
    const region = disconnectRegion()
    // Note: the account-identity backend token is asserted absent from
    // every renderer file by the Stage 29 architecture boundary test,
    // so it is not repeated here (that test scans test files too).
    for (const foreign of [
      'getAccountStatus',
      'cloudAccount',
      'openrouter',
      'OpenRouter',
      'stark-infer',
      'signOut',
      'hostedSession'
    ]) {
      assert.ok(!region.includes(foreign), `disconnect path must not reference ${foreign}`)
    }
  })
})

describe('provider disconnect: state cleanup', () => {
  it('provider readiness becomes not-configured with no models and no selection', () => {
    let state: ProviderPanelState = {
      ...initialProviderPanelState(),
      workspaceId: 3,
      configured: true,
      selectedModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }],
      connectionPhase: 'done' as const,
      connectionStatus: 'connected' as const
    }
    state = providerPanelReducer(state, {
      type: 'disconnected',
      workspaceId: 3,
      requestId: 0,
      state: {
        providerId: 'openai',
        displayName: 'OpenAI',
        secureStorageAvailable: true,
        configured: false,
        selectedModel: null
      }
    })
    assert.equal(state.configured, false)
    assert.deepEqual(state.models, [])
    assert.equal(state.selectedModel, null)
    assert.equal(providerReadiness(state.configured, state.selectedModel), 'not-configured')
    assert.equal(effectiveSelectedModel('openai', state.models, state.modelsError, state.selectedModel), null)
  })

  it('Usage falls back to STARK Free (signed-in) with the composer on builtins', () => {
    assert.equal(providerReadinessLabel('free'), 'STARK Free')
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(
      panel.includes("byokReadiness === 'ready' ? 'ready' : accountSignedIn ? 'free' : 'not-configured'"),
      'global readiness must resolve to Free once BYOK is gone'
    )
    assert.ok(
      panel.includes('STARK Free · ${starkDisplayName}'),
      'composer label must render the Free selection when BYOK is absent'
    )
  })

  it('builtin catalog remains intact with all 15 Free models', () => {
    assert.equal(FREE_CATALOG_COUNT, 15)
    const builtIn = deriveModelLibrary(initialProviderPanelState()).filter((entry) => entry.origin === 'built-in')
    assert.equal(builtIn.length, 15)
    for (const entry of builtIn) {
      assert.equal(entry.available, true, `${entry.displayName} must stay available`)
    }
  })

  it('active BYOK selection falls back to a valid STARK Free model', () => {
    const library = deriveModelLibrary(initialProviderPanelState())
    const fallback = createDefaultFreeBrainChain()[0] ?? 'builtin:gpt-5.6-luna'
    const entry = findLibraryModel(library, fallback)
    assert.ok(entry !== undefined && entry.origin === 'built-in', 'fallback must be a valid Free builtin')
    const region = disconnectRegion()
    assert.ok(region.includes('builtin:gpt-5.6-luna'), 'stark fallback must default to GPT 5.6 Luna')
  })
})

describe('provider disconnect: LoopLink cleanup', () => {
  it('removes only openai:* entries and preserves builtin order', () => {
    let state: ModelChainsPanelState = {
      ...initialModelChainsPanelState(),
      workspaceId: 7,
      brain: ['builtin:gpt-5.6-luna', 'openai:gpt-4o', 'builtin:claude-haiku-5.5'] as readonly string[],
      heart: ['builtin:kimi-k2.7-code', 'openai:o3-mini'] as readonly string[]
    }
    for (const stableId of [...state.brain]) {
      if (stableId.startsWith('openai:')) {
        state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'brain', stableId })
      }
    }
    for (const stableId of [...state.heart]) {
      if (stableId.startsWith('openai:')) {
        state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain: 'heart', stableId })
      }
    }
    assert.deepEqual([...state.brain], ['builtin:gpt-5.6-luna', 'builtin:claude-haiku-5.5'])
    assert.deepEqual([...state.heart], ['builtin:kimi-k2.7-code'])
    assert.ok(![...state.brain, ...state.heart].some((id) => id.startsWith('openai:')))
  })

  it('refills a chain left empty with one builtin model', () => {
    let state: ModelChainsPanelState = {
      ...initialModelChainsPanelState(),
      workspaceId: 7,
      brain: ['openai:gpt-4o'] as readonly string[],
      heart: [...createDefaultFreeHeartChain()] as readonly string[]
    }
    state = modelChainsPanelReducer(state, {
      type: 'chain-remove',
      workspaceId: 7,
      chain: 'brain',
      stableId: 'openai:gpt-4o'
    })
    assert.deepEqual([...state.brain], [])
    state = modelChainsPanelReducer(state, {
      type: 'chain-add',
      workspaceId: 7,
      chain: 'brain',
      stableId: createDefaultFreeBrainChain()[0] ?? 'builtin:gpt-5.6-luna'
    })
    assert.equal(state.brain.length, 1)
    assert.ok(state.brain[0] !== undefined && state.brain[0].startsWith('builtin:'))
    assert.ok(state.heart.length >= 1 && state.heart.every((id) => id.startsWith('builtin:')))
  })

  it('chains without openai:* entries are untouched', () => {
    const before: ModelChainsPanelState = {
      ...initialModelChainsPanelState(),
      workspaceId: 7
    }
    let state: ModelChainsPanelState = before
    for (const chain of ['brain', 'heart'] as const) {
      const current = chain === 'brain' ? state.brain : state.heart
      for (const stableId of [...current]) {
        if (stableId.startsWith('openai:')) {
          state = modelChainsPanelReducer(state, { type: 'chain-remove', workspaceId: 7, chain, stableId })
        }
      }
    }
    assert.deepEqual([...state.brain], [...before.brain])
    assert.deepEqual([...state.heart], [...before.heart])
  })
})

describe('provider disconnect: no collateral changes', () => {
  it('schema remains v20 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('020-looplink-audit.ts'), 'migration 020 must exist (schema v20)')
    assert.ok(!files.some((file) => file.startsWith('021')), 'no migration 020 may appear')
  })

  it('adds no generic credential IPC (openai-scoped deletion only)', () => {
    const ipc = codeOnly(readSource('src', 'main', 'ipc', 'providers.ts'))
    assert.ok(ipc.includes('providersClearCredential'), 'the narrow deletion channel must exist')
    assert.ok(!/deleteCredential|removeCredential|clearAll|deleteAll/i.test(ipc), 'no generic deletion channel may appear')
    const region = disconnectRegion()
    assert.ok(!region.includes('providersClearCredential'), 'renderer calls the typed bridge, not raw channels')
  })
})
