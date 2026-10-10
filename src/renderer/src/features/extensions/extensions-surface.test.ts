import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * EXTENSIONS STEP 5 — installed management (enable/disable + views).
 *
 * Static guarantees: Marketplace and Installed are separate views with
 * a local-only count; installed rows show stored icons, Enabled /
 * Disabled state, and Enable / Disable / Uninstall controls; state
 * flips send identity plus a boolean through the narrow bridge with
 * user-initiated retry; activation is never claimed (single subtle
 * note); no execution surface anywhere. Renderer-only assertions;
 * the state file, bindings, and preload contract are covered
 * main-side.
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

  it('installed view exists separately with a local-only count', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('Marketplace'), 'Marketplace tab must exist')
    assert.ok(panel.includes('Installed ('), 'Installed tab must exist with a local count')
    assert.ok(panel.includes("setView('marketplace')") && panel.includes("setView('installed')"), 'view switch must be renderer-local tabs')
    assert.ok(panel.includes('No extensions installed yet'), 'empty Installed view must guide to Marketplace')
    assert.ok(panel.includes('>Installed</p>'), 'Installed view must carry its heading')
    assert.ok(panel.includes('listInstalledExtensions'), 'installed list must load from the bridge')
    assert.ok(panel.includes('nothing runs at startup'), 'installed packages must read as on-demand only')
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
    assert.ok(panel.includes('src={iconUrl}'), 'rows must render the normalized icon URL')
    assert.ok(panel.includes('iconUrl === null'), 'absent icons must fall back without requesting')
    assert.ok(panel.includes('setFailedUrl(iconUrl)'), 'a failed load must pin that URL once')
    assert.ok(panel.includes('failedUrl === iconUrl'), 'a new URL must retry instead of sticking on fallback')
    assert.ok(panel.includes('extensions__icon-fallback'), 'fallback must be the local generic glyph')
    assert.equal(panel.split('onError').length - 1, 1, 'exactly one error handler may exist, so no reload loop is possible')
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const icon = css.match(/\.extensions__icon\s*\{[^}]*\}/)
    assert.ok(icon !== null && icon[0].includes('width: 40px'), 'icon box must stay fixed at 40px')
    assert.ok(icon[0].includes('object-fit: contain'), 'icons must preserve aspect ratio')
  })

  it('installed rows show stored icons, state labels, and Enable/Disable controls', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('>Enable<') || panel.includes('Enable\n'), 'disabled rows must offer Enable')
    assert.ok(panel.includes('>Disable<') || panel.includes('Disable\n'), 'enabled rows must offer Disable')
    assert.ok(panel.includes('Enabled · ') || panel.includes("'Enabled'"), 'enabled state label must render (with Loaded distinction)')
    assert.ok(panel.includes('Disabled'), 'disabled state label must render')
    assert.ok(panel.includes('aria-label={`Enable ${item.displayName}`}'), 'Enable must be labelled')
    assert.ok(panel.includes('aria-label={`Disable ${item.displayName}`}'), 'Disable must be labelled')
    assert.ok(panel.includes('setExtensionEnabled'), 'state flips must go through the narrow bridge')
    assert.ok(panel.includes('Couldn’t update extension state.'), 'state failure copy must exist')
    assert.ok(panel.includes('stateChangingKeys.includes(key)'), 'rapid repeats must share one in-flight change')
    assert.ok(panel.includes('nothing runs at startup'), 'installed view must note on-demand activation only')
    assert.ok(panel.includes('Enabled · Loaded') || panel.includes('Not loaded'), 'installed view may distinguish Loaded when main knows it')
    for (const falseClaim of ['>Running<', '>Active<', 'is running', 'is now active']) {
      assert.ok(!panel.includes(falseClaim), `panel must never claim execution (${falseClaim})`)
    }
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(api.includes('setExtensionEnabled'), 'bridge must expose the enable/disable helper')
  })

  it('management surfaces stay narrow (details, updates, trust — never raw execution)', () => {
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    // Step 8+9 completion surfaces: details, manual updates with
    // install-alongside semantics, explicit trust, proposals inbox.
    // Everything that would load, run, or fetch third-party code from
    // the renderer stays forbidden.
    for (const forbidden of ['child_process', 'require(', 'import(', 'postinstall', '.vsix', 'activationEvents', 'dangerouslySetInnerHTML', 'innerHTML', '__html', 'fetch(']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    for (const expected of ['Details', 'Update to', 'Automatically update extensions', 'Trust this extension', 'Proposed edits', 'Disable all', 'Enable all']) {
      assert.ok(panel.includes(expected), `panel must contain ${expected}`)
    }
    const api = readRenderer('lib/stark-api.ts')
    assert.ok(!api.includes('vsix'), 'bridge helpers must not handle archives')
  })

  it('host UI is read-only status (no manual host management)', () => {    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('Extension Host'), 'host block must be present')
    assert.ok(panel.includes('Status: {hostState}'), 'status text must render')
    assert.ok(!panel.includes('Start host') && !panel.includes('Stop host'), 'normal users must not manage the host')
    assert.ok(panel.includes('run on demand'), 'panel must describe on-demand execution')
    assert.ok(!panel.includes('Enable extensions'), 'must never be labeled Enable extensions')
    const api = readRenderer('lib/stark-api.ts')
    for (const helper of ['getExtensionHostStatus']) {
      assert.ok(api.includes(helper), `bridge must expose ${helper}`)
    }
    const settings = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(settings.includes('Extension Host:'), 'developer diagnostics must retain host status under Settings About')
  })

  it('palette offers built-in Format Document through the open file, never the runtime', () => {
    const overlays = readRenderer('features/extensions/ExtensionOverlays.tsx')
    assert.ok(overlays.includes('stark.formatDocument'), 'palette must list the built-in format command')
    assert.ok(overlays.includes('Format Document'), 'built-in entry must carry its title')
    assert.ok(overlays.includes('requestFormatDocument'), 'built-in run must publish through the format bus')
    assert.ok(overlays.includes("startsWith('stark.')"), 'built-ins must bypass extension invocation')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('subscribeFormatRequests'), 'the open file must subscribe to palette requests')
    assert.ok(explorer.includes('handleFormatRequest'), 'palette requests must run the existing format handler')
    assert.ok(!overlays.includes('formatDocumentWithPrettier'), 'palette must not call the formatter directly')
    assert.ok(!overlays.includes('createFileChange'), 'palette must not write or propose directly')
  })

  it('only normalized shapes cross the bridge', () => {    const types = readSource('src', 'shared', 'extension-registry', 'types.ts')
    for (const field of ['namespace', 'name', 'version', 'displayName', 'status', 'enabled', 'setEnabled']) {
      assert.ok(types.includes(field), `install contract must carry ${field}`)
    }
    assert.ok(!types.includes('downloadUrl') && !types.includes('vsix') && !types.includes('installPath'), 'paths and archives must not exist in the contract')
  })

  it('only the extension channels exist; schema stays v19', () => {
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
      "extensionsSetEnabled: 'stark:extensions:set-enabled'",
      "extensionsHostStatus: 'stark:extensions:host-status'",
      "extensionsHostStart: 'stark:extensions:host-start'",
      "extensionsHostStop: 'stark:extensions:host-stop'",
      "extensionsGetDetails: 'stark:extensions:get-details'",
      "extensionsSetTrust: 'stark:extensions:set-trust'",
      "extensionsAcknowledgeAndActivate: 'stark:extensions:acknowledge-and-activate'",
      "extensionsFireTrigger: 'stark:extensions:fire-trigger'",
      "extensionsListCommands: 'stark:extensions:list-commands'",
      "extensionsInvokeCommand: 'stark:extensions:invoke-command'",
      "extensionsQueryProviders: 'stark:extensions:query-providers'",
      "extensionsGetDiagnostics: 'stark:extensions:get-diagnostics'",
      "extensionsListEditProposals: 'stark:extensions:list-edit-proposals'",
      "extensionsCheckUpdate: 'stark:extensions:check-update'",
      "extensionsGetAutoUpdate: 'stark:extensions:get-auto-update'",
      "extensionsSetAutoUpdate: 'stark:extensions:set-auto-update'",
      "extensionsListPrompts: 'stark:extensions:list-prompts'",
      "extensionsResolvePrompt: 'stark:extensions:resolve-prompt'",
      "extensionsPushDocumentEvent: 'stark:extensions:push-document-event'",
      "extensionsSetWorkspaceFolders: 'stark:extensions:set-workspace-folders'"
    ]) {
      assert.ok(constants.includes(channel), `${channel} must be narrowly scoped`)
    }    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
