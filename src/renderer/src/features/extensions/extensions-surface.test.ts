import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * EXTENSIONS STEP 3 — safe uninstall.
 *
 * Static guarantees: uninstall requires explicit inline confirmation,
 * sends normalized identity only through the main-owned bridge, shows
 * Uninstalling/failed states with user-initiated retry, and refreshes
 * the INSTALLED section. No update/enable/disable/run surface, no
 * activation, no host, no execution anywhere. Renderer-only
 * assertions; the removal service, bindings, and preload contract are
 * covered main-side.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('extensions install surface', () => {
  it('Install sends normalized identity only through the bridge', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('installExtension({ namespace: entry.namespace, name: entry.name, version: entry.version })'), 'install must send identity only')
    assert.ok(!panel.includes('open-vsx.org'), 'renderer must never name the registry origin')
    assert.ok(!panel.includes('fetch('), 'renderer must never fetch or download directly')
    assert.ok(!panel.includes('XMLHttpRequest'), 'no raw network primitives may appear')
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(api.includes('installExtension'), 'install bridge helper must exist')
    assert.ok(api.includes('listInstalledExtensions'), 'installed-list helper must exist')
  })

  it('rows show Install, Installing, Installed, and Retry states', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('>Install<') || panel.includes('Install\n'), 'Install button must exist')
    assert.ok(panel.includes('Installing…'), 'in-progress state must exist')
    assert.ok(panel.includes('Installed\n') || panel.includes('>Installed<'), 'installed state must exist')
    assert.ok(panel.includes('Install failed'), 'failure copy must exist')
    assert.ok(panel.includes('handleInstall'), 'retry must re-run the install explicitly')
    assert.ok(panel.includes('installingIds.includes(entry.id)'), 'duplicate clicks must reuse in-progress state')
    assert.ok(panel.includes('aria-label={`Install ${entry.displayName}`}'), 'Install must be labelled')
  })

  it('installed section lists inert entries without controls', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('INSTALLED') || panel.includes('>Installed</p>'), 'INSTALLED section must exist')
    assert.ok(panel.includes('listInstalledExtensions'), 'installed list must load from the bridge')
    assert.ok(panel.includes('nothing runs yet'), 'installed packages must read as inert')
  })

  it('uninstall requires confirmation and sends identity only', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('uninstallExtension({ namespace: item.namespace, name: item.name, version: item.version })'), 'uninstall must send identity only')
    assert.ok(panel.includes('Uninstall {item.displayName}?'), 'confirmation must name the extension')
    assert.ok(panel.includes('It does not modify your'), 'confirmation must promise project safety')
    assert.ok(panel.includes('handleUninstallCancel'), 'confirmation must offer Cancel')
    assert.ok(panel.includes('Uninstalling…'), 'removal progress must exist')
    assert.ok(panel.includes('Uninstall failed'), 'removal failure copy must exist')
    assert.ok(panel.includes('handleUninstallConfirm'), 'confirm must run the removal explicitly')
    assert.ok(panel.includes('uninstallingKeys.includes(key)'), 'duplicate clicks must reuse in-progress state')
    assert.ok(panel.includes('refreshInstalled'), 'installed state must refresh after removal')
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(api.includes('uninstallExtension'), 'uninstall bridge helper must exist')
  })

  it('search behavior and inert rendering are preserved', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('CATALOG_DEBOUNCE_MS = 300'), 'debounce must stay exactly 300ms')
    assert.ok(panel.includes('requestIdRef.current !== requestId'), 'stale responses must stay discarded')
    assert.ok(panel.includes('{entry.displayName}'), 'names must render as text')
    assert.ok(panel.includes('Catalog only'), 'rows must keep the catalog-only badge')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
  })

  it('catalog icons render from normalized URLs with one-shot fallback', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('src={entry.iconUrl}'), 'rows must render the normalized icon URL')
    assert.ok(panel.includes('entry.iconUrl === null'), 'absent icons must fall back without requesting')
    assert.ok(panel.includes('onError={() => setFailed(true)}'), 'a failed load must swap that row once')
    assert.ok(panel.includes('extensions__icon-fallback'), 'fallback must be the local generic glyph')
    assert.equal(panel.split('onError').length - 1, 1, 'exactly one error handler may exist, so no reload loop is possible')
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const icon = css.match(/\.extensions__icon\s*\{[^}]*\}/)
    assert.ok(icon !== null && icon[0].includes('width: 40px'), 'icon box must stay fixed at 40px')
    assert.ok(icon[0].includes('object-fit: contain'), 'icons must preserve aspect ratio')
  })

  it('no activation, host execution, or update surface exists', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    for (const forbidden of ['>Enable<', '>Disable<', '>Run<', '>Update<', 'Enable extensions', 'auto-update', 'Auto-update', '.vsix', 'activationEvents', 'postinstall', 'deactivate', 'child_process', 'require(', 'import(']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(!api.includes('vsix'), 'bridge helpers must not handle archives')
  })

  it('host foundation UI shows status with start/stop only', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('Extension Host'), 'host block must be present')
    assert.ok(panel.includes('Status: {hostState}'), 'status text must render')
    assert.ok(panel.includes('Start host') && panel.includes('Stop host'), 'start/stop controls must exist')
    assert.ok(panel.includes('cannot run yet'), 'panel must not imply extensions can run')
    assert.ok(!panel.includes('Enable extensions'), 'must never be labeled Enable extensions')
    const api = readRenderer('lib/stark-api.ts')
    for (const helper of ['getExtensionHostStatus', 'startExtensionHost', 'stopExtensionHost']) {
      assert.ok(api.includes(helper), `bridge must expose ${helper}`)
    }
  })

  it('only normalized shapes cross the bridge', () => {
    const types = readSource('src', 'shared', 'extension-registry', 'types.ts')
    for (const field of ['namespace', 'name', 'version', 'displayName', 'status']) {
      assert.ok(types.includes(field), `install contract must carry ${field}`)
    }
    assert.ok(!types.includes('downloadUrl') && !types.includes('vsix') && !types.includes('installPath'), 'paths and archives must not exist in the contract')
  })

  it('only the extension channels exist; schema stays v18', () => {
    for (const file of ['features/extensions/ExtensionsPanel.tsx', 'lib/stark-api.ts']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
    const constants = readSource('src', 'shared', 'constants', 'index.ts')
    for (const channel of [
      "extensionsSearch: 'stark:extensions:search'",
      "extensionsListFeatured: 'stark:extensions:list-featured'",
      "extensionsInstall: 'stark:extensions:install'",
      "extensionsListInstalled: 'stark:extensions:list-installed'",
      "extensionsUninstall: 'stark:extensions:uninstall'",
      "extensionsHostStatus: 'stark:extensions:host-status'",
      "extensionsHostStart: 'stark:extensions:host-start'",
      "extensionsHostStop: 'stark:extensions:host-stop'"
    ]) {
      assert.ok(constants.includes(channel), `${channel} must be narrowly scoped`)
    }
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
