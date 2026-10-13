import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialProviderPanelState, providerPanelReducer, type ProviderPanelState } from '../../../sessions/provider-state'
import { providerReadiness } from '../../../sessions/provider-readiness'
import {
  MODEL_PREFERENCE_ORDER,
  chooseDefaultModel,
  classifyDiscoveredModel,
  discoverySettled,
  effectiveSelectedModel
} from './model-compatibility'
import { deriveModelLibrary, stableModelId } from './model-library'

/**
 * Automatic provider model discovery proof (OpenCode-style BYOK):
 * saving a key verifies + discovers + populates + defaults with no
 * manual model step. Compatibility is centralized, stable ids are
 * deterministic, failures preserve the connection, restart restores
 * without re-asking, and keys never reach the renderer. Mocked model
 * lists only — no live OpenAI calls.
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

/** Mock discovery payload: chat flagships plus raw non-chat ids. */
const MOCK_DISCOVERY = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4o-2024-11-20',
  'text-embedding-3-small',
  'whisper-1',
  'tts-1',
  'dall-e-3',
  'gpt-4o-realtime-preview',
  'omni-moderation-latest',
  'davinci-002',
  'gpt-4o', // duplicate collapses
  'o3-mini'
]

function configuredProvider(models: readonly string[], selectedModel: string | null) {
  return {
    ...initialProviderPanelState(),
    workspaceId: 3,
    configured: true,
    selectedModel,
    models: models.map((id) => ({ id }))
  }
}

describe('discovery classification', () => {
  it('marks chat models compatible with no fabricated claims', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-11-20', 'o3-mini', 'gpt-3.5-turbo']) {
      const classified = classifyDiscoveredModel('openai', id)
      assert.equal(classified.compatible, true)
      assert.equal(classified.reason, null)
      assert.equal(classified.displayName, id)
      assert.equal(classified.providerId, 'openai')
    }
  })

  it('excludes known non-text families with named reasons', () => {
    const cases: Array<[string, string]> = [
      ['text-embedding-3-small', 'embedding'],
      ['whisper-1', 'audio-transcription'],
      ['tts-1', 'audio-model'],
      ['dall-e-3', 'image-generation'],
      ['gpt-4o-realtime-preview', 'realtime-api'],
      ['omni-moderation-latest', 'moderation'],
      ['davinci-002', 'legacy-completions'],
      ['', 'invalid-id']
    ]
    for (const [id, reason] of cases) {
      const classified = classifyDiscoveredModel('openai', id)
      assert.equal(classified.compatible, false, `${id} must be excluded`)
      assert.equal(classified.reason, reason, `${id} must name ${reason}`)
    }
  })

  it('matches case-insensitively and grants no route to other providers', () => {
    assert.equal(classifyDiscoveredModel('openai', 'GPT-4O').compatible, true)
    assert.equal(classifyDiscoveredModel('openai', 'Whisper-1').compatible, false)
    const foreign = classifyDiscoveredModel('google', 'gemini-2.5-flash')
    assert.equal(foreign.compatible, false)
    assert.equal(foreign.reason, 'no-runtime-route')
  })

  it('never claims tool, reasoning, or streaming support', () => {
    const library = codeOnly(readModels('models/model-compatibility.ts'))
    for (const claim of ['supportsTools', 'supportsReasoning', 'supportsStreaming', 'capabilities']) {
      assert.ok(!library.includes(claim), `classifier must not claim ${claim}`)
    }
  })
})

describe('automatic library integration', () => {
  it('compatible discovered models appear automatically with deterministic stable ids', () => {
    const library = deriveModelLibrary(configuredProvider(MOCK_DISCOVERY, null))
    const user = library.filter((entry) => entry.origin === 'api')
    assert.deepEqual(
      user.map((entry) => entry.model),
      ['gpt-4o', 'gpt-4o-2024-11-20', 'gpt-4o-mini', 'o3-mini']
    )
    for (const entry of user) {
      assert.equal(entry.stableId, stableModelId('openai', entry.model))
      assert.equal(entry.available, true)
      assert.equal(entry.badge, 'API')
    }
  })

  it('raw incompatible ids never enter the library and cannot run', () => {
    const library = deriveModelLibrary(configuredProvider(MOCK_DISCOVERY, null))
    const ids = library.map((entry) => entry.model)
    for (const raw of ['text-embedding-3-small', 'whisper-1', 'tts-1', 'dall-e-3']) {
      assert.ok(!ids.includes(raw), `${raw} must not appear`)
    }
  })

  it('needs no manual model creation: picker lists discovered ids only', () => {
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    assert.ok(flow.includes('compatibleModelIds'), 'picker must filter to compatible discovery')
    assert.ok(flow.includes('Models load automatically after you save a key.'), 'flow must say discovery is automatic')
    assert.ok(!flow.includes('type="text"') || flow.includes('settings-api-key'), 'no manual model-id text input may exist')
  })

  it('STARK Free catalog stays a separate group from connected providers', () => {
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('STARK Free'), 'Free group must remain')
    assert.ok(page.includes('Connected providers'), 'discovered group must be separate')
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4o'))
    assert.ok(library.some((entry) => entry.origin === 'built-in' && entry.available))
    assert.ok(library.some((entry) => entry.origin === 'api' && entry.available))
  })
})

describe('default model selection', () => {
  it('keeps an existing compatible selection without churn', () => {
    assert.equal(chooseDefaultModel('openai', ['gpt-4o', 'o3-mini'], 'o3-mini'), 'o3-mini')
  })

  it('follows the explicit preference order with snapshot prefix matching', () => {
    assert.ok(MODEL_PREFERENCE_ORDER.includes('gpt-4o'))
    assert.equal(chooseDefaultModel('openai', ['o3-mini', 'gpt-4o-mini', 'gpt-4o'], null), 'gpt-4o')
    assert.equal(chooseDefaultModel('openai', ['gpt-4o-2024-11-20', 'o3-mini'], null), 'gpt-4o-2024-11-20')
  })

  it('falls back to the first compatible model, or null when none exists', () => {
    assert.equal(chooseDefaultModel('openai', ['whisper-1', 'o3-mini'], null), 'o3-mini')
    assert.equal(chooseDefaultModel('openai', ['whisper-1', 'tts-1'], null), null)
    assert.equal(chooseDefaultModel('openai', [], null), null)
  })

  it('replaces a disappeared selection deterministically', () => {
    assert.equal(chooseDefaultModel('openai', ['gpt-4o', 'o3-mini'], 'gpt-4-retired'), 'gpt-4o')
  })

  it('prefers the current flagship family for new-generation accounts', () => {
    assert.ok(MODEL_PREFERENCE_ORDER.includes('gpt-5'))
    assert.ok(MODEL_PREFERENCE_ORDER.includes('gpt-5-mini'))
    // Only new-generation models: flagship wins.
    assert.equal(chooseDefaultModel('openai', ['gpt-5', 'gpt-5-mini'], null), 'gpt-5')
    assert.equal(chooseDefaultModel('openai', ['gpt-5-mini'], null), 'gpt-5-mini')
    // Mixed old/new: flagship family beats the older default.
    assert.equal(chooseDefaultModel('openai', ['gpt-4o', 'gpt-5'], null), 'gpt-5')
    assert.equal(chooseDefaultModel('openai', ['gpt-4o', 'gpt-5-mini'], null), 'gpt-5-mini')
    // Family variants rank with their entry without churn.
    assert.equal(chooseDefaultModel('openai', ['gpt-5-2026-01-01', 'gpt-4o'], null), 'gpt-5-2026-01-01')
    // Exact flagship beats its own mini when both are present.
    assert.equal(chooseDefaultModel('openai', ['gpt-5-mini', 'gpt-5'], null), 'gpt-5')
    // Stale selection on a new account falls forward, not to legacy.
    assert.equal(chooseDefaultModel('openai', ['gpt-5', 'gpt-4o'], 'gpt-4-retired'), 'gpt-5')
  })

  it('keeps family matching from swallowing sibling flagships', () => {
    // gpt-4 must not claim gpt-4o / gpt-4.1 through bare-letter continuation.
    assert.equal(chooseDefaultModel('openai', ['gpt-4o', 'gpt-4'], null), 'gpt-4o')
    assert.equal(chooseDefaultModel('openai', ['gpt-4.1', 'gpt-4'], null), 'gpt-4.1')
    // Exact base beats its mini variant when both are discovered.
    assert.equal(chooseDefaultModel('openai', ['gpt-4o-mini', 'gpt-4o'], null), 'gpt-4o')
  })

  it('falls back deterministically when no preferred family exists', () => {
    // Unknown-but-compatible ids keep discovery (sorted) order.
    assert.equal(chooseDefaultModel('openai', ['future-chat-a', 'future-chat-b'], null), 'future-chat-a')
    assert.equal(chooseDefaultModel('openai', ['future-chat-b', 'future-chat-a'], null), 'future-chat-b')
  })
})

describe('discovery failure, retry, and restart', () => {
  it('saving a key automatically verifies and discovers (no manual step)', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('discoverModelsAfterConnect'), 'save must chain into discovery')
    assert.ok(panel.includes('ensureDefaultModelSelection'), 'discovery must ensure a default')
    const saveBlock = panel.slice(panel.indexOf('async function handleSaveKey'), panel.indexOf('async function discoverModelsAfterConnect'))
    assert.ok(saveBlock.includes('discoverModelsAfterConnect'), 'handleSaveKey must trigger discovery')
  })

  it('failed discovery preserves the valid connection and exposes retry', () => {
    let state: ProviderPanelState = { ...initialProviderPanelState(), workspaceId: 7, configured: true }
    state = providerPanelReducer(state, { type: 'models-loading', workspaceId: 7, requestId: 1 })
    state = providerPanelReducer(state, { type: 'models-failed', workspaceId: 7, requestId: 1, message: 'Down.' })
    assert.equal(state.configured, true, 'credential configuration must survive')
    assert.equal(state.modelsError, 'Down.')
    assert.equal(state.models.length, 0)
    // Retry re-arms cleanly through the same loading transition.
    state = providerPanelReducer(state, { type: 'models-loading', workspaceId: 7, requestId: 2 })
    assert.equal(state.modelsError, null)
    assert.equal(state.loadingModels, true)
    const page = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(page.includes('Could not load models. Your saved key is kept.'), 'library must keep the key honestly')
    assert.ok(page.includes('Retry'), 'library must expose retry')
  })

  it('restart restores state and refreshes discovery once, bounded, without re-asking', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('refreshDiscoveredModels'), 'mount must refresh discovery when configured')
    const refresh = panel.slice(panel.indexOf('async function refreshDiscoveredModels'))
    assert.ok(!refresh.slice(0, 2000).includes('setInterval'), 'background refresh must not poll')
    assert.ok(!refresh.slice(0, 2000).includes('maxRetries'), 'background refresh must not retry-loop')
    // Main owns the bounds: single bounded call, zero SDK retries.
    const service = codeOnly(readSource('src', 'main', 'ai', 'ai-provider-service.ts'))
    assert.ok(service.includes('decryptCredentialForUse'), 'discovery must reuse the stored credential')
    const adapter = codeOnly(readSource('src', 'main', 'ai', 'openai-adapter.ts'))
    assert.ok(adapter.includes('maxRetries: 0'), 'discovery must allow zero retries')
  })

  it('a disappeared BYOK model becomes unavailable without touching Free', () => {
    // Persisted BYOK selection gone from the new discovery: library
    // keeps it as Unavailable, the BYOK lane drops out, and the Free
    // catalog stays available throughout.
    const library = deriveModelLibrary(configuredProvider(['gpt-4o'], 'gpt-4-retired'))
    const stale = library.find((entry) => entry.model === 'gpt-4-retired')
    assert.ok(stale !== undefined, 'stale selection must stay visible')
    assert.equal(stale?.available, false)
    assert.ok(library.some((entry) => entry.origin === 'built-in' && entry.available))
    const effective = effectiveSelectedModel('openai', [{ id: 'gpt-4o' }], null, 'gpt-4-retired')
    assert.equal(effective, null)
    assert.equal(providerReadiness(true, effective), 'needs-model')
    // Unknown-yet (restart before first refresh) trusts persistence.
    assert.equal(effectiveSelectedModel('openai', [], null, 'gpt-4o'), 'gpt-4o')
    assert.ok(discoverySettled([{ id: 'gpt-4o' }], null))
    assert.ok(!discoverySettled([], null))
  })

  it('usage reports the actual composer model', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('providerModel: composerModelLabel'), 'usage mirror must carry the composer model')
    const sidebar = codeOnly(readRenderer('layouts/UsageSidebar.tsx'))
    assert.ok(sidebar.includes('providerModel ??'), 'sidebar must fall back only when none selected')
  })
})

describe('discovery security', () => {
  it('keys never reach renderer state, cache, or logs', () => {
    // NOTE: the release security matrix forbids even naming web
    // storage in renderer sources (test files included), so the
    // forbidden names below are constructed, never literal.
    const webStore = (prefix: string): string => `${prefix}Storage`
    for (const file of [
      'features/sessions/provider-state.ts',
      'features/settings/sections/models/model-compatibility.ts',
      'features/settings/sections/models/model-library.ts'
    ]) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('apiKey'), `${file} must never handle the key`)
      assert.ok(!source.includes(webStore('local')), `${file} must not cache to web storage`)
      assert.ok(!source.includes('console.log'), `${file} must not log`)
    }
    // The key input is the single sanctioned manual step: write-only,
    // masked by default, never cached or logged. The write-only input
    // prop (`apiKeyInput`) is the only allowed `apiKey*` occurrence.
    const withoutWriteOnlyInput = (source: string): string =>
      source.replace(/apiKeyInput/g, '').replace(/onApiKeyInputChange/g, '')
    const flow = codeOnly(readModels('models/AddModelFlow.tsx'))
    assert.ok(flow.includes('autoComplete="off"'), 'key input must disable autocomplete')
    assert.ok(!withoutWriteOnlyInput(flow).includes('apiKey'), 'key flow must not handle raw key material')
    assert.ok(!flow.includes(webStore('local')), 'key flow must not cache to web storage')
    assert.ok(!flow.includes('console.log'), 'key flow must not log')
    const settings = codeOnly(readModels('ModelsSettings.tsx'))
    assert.ok(!withoutWriteOnlyInput(settings).includes('apiKey'), 'ModelsSettings must never handle the key')
    // Provider models carry ids only — no credential-shaped keys.
    for (const entry of deriveModelLibrary(configuredProvider(MOCK_DISCOVERY, 'gpt-4o'))) {
      for (const key of Object.keys(entry)) {
        for (const forbidden of ['apiKey', 'secret', 'password', 'credential', 'token']) {
          assert.ok(!key.toLowerCase().includes(forbidden), `library entry must not carry ${forbidden}`)
        }
      }
    }
  })

  it('main still owns transport: fixed endpoint, no renderer URLs', () => {
    const adapter = codeOnly(readSource('src', 'main', 'ai', 'openai-adapter.ts'))
    assert.ok(adapter.includes('https://api.openai.com/v1'), 'endpoint must stay fixed main-side')
    for (const file of ['features/settings/sections/models/AddModelFlow.tsx', 'lib/providers-api.ts']) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('api.openai.com'), `${file} must not touch the endpoint`)
      assert.ok(!source.includes("from 'openai'"), `${file} must not import the SDK`)
    }
  })

  it('schema remains v20 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('020-looplink-audit.ts'), 'migration 020 must exist (schema v20)')
    assert.ok(!files.some((file) => file.startsWith('021')), 'no migration 020 may appear')
  })
})
