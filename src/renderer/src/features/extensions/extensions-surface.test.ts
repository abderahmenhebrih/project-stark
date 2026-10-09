import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * EXTENSIONS STEP 1 — real Open VSX catalog, display only.
 *
 * Static guarantees: the panel searches through the main-owned
 * bridge (never the registry directly), debounces 300ms with stale
 * protection, renders normalized metadata as inert text, and exposes
 * no setup/download/host surface. Renderer-only assertions; the
 * service, bindings, and preload contract are covered main-side.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('extensions catalog surface', () => {
  it('panel searches through the main-owned bridge only', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('searchExtensionCatalog'), 'panel must call the bridge search helper')
    assert.ok(panel.includes('listFeaturedExtensions'), 'empty query must load the default catalog')
    assert.ok(!panel.includes('open-vsx.org'), 'renderer must never name the registry origin')
    assert.ok(!panel.includes('fetch('), 'renderer must never fetch the registry directly')
    assert.ok(!panel.includes('XMLHttpRequest'), 'no raw network primitives may appear')
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(api.includes('searchExtensionCatalog'), 'bridge helper must exist')
    assert.ok(api.includes('listFeaturedExtensions'), 'featured helper must exist')
  })

  it('search debounces 300ms with stale-response protection', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('CATALOG_DEBOUNCE_MS = 300'), 'debounce must be exactly 300ms')
    assert.ok(panel.includes('setTimeout'), 'typing must schedule a debounced request')
    assert.ok(panel.includes('clearTimeout(timer)'), 'rapid typing must cancel the pending timer')
    assert.ok(panel.includes('requestIdRef'), 'monotonic request ids must guard overlapping requests')
    assert.ok(panel.includes('requestIdRef.current !== requestId'), 'older responses must not overwrite newer results')
    assert.ok(!panel.includes('setInterval'), 'no polling may exist')
  })

  it('empty query loads the default catalog; failures offer user retry only', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes("trimmed === ''"), 'empty query must take the catalog path')
    assert.ok(panel.includes('Loading extensions…'), 'subtle loading copy must exist')
    assert.ok(panel.includes('We couldn’t load extensions.'), 'calm error copy must exist')
    assert.ok(panel.includes('Retry'), 'user-initiated retry must exist')
    assert.ok(panel.includes('handleRetry'), 'retry must re-run the current query explicitly')
  })

  it('rows render normalized metadata as inert text with a catalog badge', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('{entry.displayName}'), 'names must render as text')
    assert.ok(panel.includes('{entry.publisher}'), 'publishers must render as text')
    assert.ok(panel.includes('{entry.description}'), 'descriptions must render as plain text')
    assert.ok(panel.includes('Catalog only'), 'rows must carry the catalog-only badge')
    assert.ok(panel.includes('Built-in'), 'built-in capabilities must stay clearly labeled')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
  })

  it('no setup, download, or host surface exists', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    // Note: the legitimate normalized `downloadCount` metadata field is
    // asserted separately; these tokens target action affordances only.
    for (const forbidden of ['Install', 'install', 'Enable', 'Disable', '>Download<', 'Download ', '.vsix', 'vsix']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    assert.ok(!panel.includes('fetch('), 'no registry fetch may live in the panel')
  })

  it('only normalized metadata shapes cross the bridge', () => {
    const types = readSource('src', 'shared', 'extension-registry', 'types.ts')
    for (const field of ['displayName', 'publisher', 'description', 'version', 'downloadCount', 'rating', 'iconUrl', 'verified']) {
      assert.ok(types.includes(field), `normalized entry must carry ${field}`)
    }
    assert.ok(!types.includes('downloadUrl') && !types.includes('vsix'), 'raw download fields must not exist in the contract')
  })

  it('no new IPC beyond the two catalog channels; schema stays v18', () => {
    for (const file of [
      'features/extensions/ExtensionsPanel.tsx',
      'lib/stark-api.ts'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
    const constants = readSource('src', 'shared', 'constants', 'index.ts')
    assert.ok(constants.includes("extensionsSearch: 'stark:extensions:search'"), 'search channel must be narrowly scoped')
    assert.ok(constants.includes("extensionsListFeatured: 'stark:extensions:list-featured'"), 'featured channel must be narrowly scoped')
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('018-cloud-account.ts'), 'migration 018 must exist (schema v18)')
    assert.ok(!files.some((file) => file.startsWith('019')), 'no migration 019 may appear')
  })
})
