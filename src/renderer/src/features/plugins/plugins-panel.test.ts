import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Plugins activity placeholder proof (locked product decision):
 * the Changes drawer activity is replaced by a Plugins placeholder
 * in the same rail position, while Change Transactions / Change Sets
 * / review-before-write stay fully intact underneath.
 * Runs against repository source (cwd is the repo root via npm).
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

/** Source with line/block comments removed, so assertions test code — not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('plugins activity replaces changes', () => {
  it('Changes no longer appears in the activity rail', () => {
    const rail = codeOnly(readRenderer('features/explorer/ActivityRail.tsx'))
    assert.ok(!rail.includes("'changes'"), 'rail must not declare the removed activity')
    assert.ok(!rail.includes("label: 'Changes'"), 'rail must not label the removed activity')
  })

  it('Plugins appears where Changes was, order otherwise unchanged', () => {
    const rail = codeOnly(readRenderer('features/explorer/ActivityRail.tsx'))
    const kinds = ['explorer', 'search', 'plugins', 'git', 'extensions', 'terminal'].map((kind) =>
      rail.indexOf(`kind: '${kind}'`)
    )
    for (const found of kinds) {
      assert.ok((found ?? -1) >= 0, 'rail must declare all six current activities')
    }
    for (let index = 1; index < kinds.length; index += 1) {
      assert.ok((kinds[index] ?? -1) > (kinds[index - 1] ?? -1), 'rail order must stay Explorer/Search/Plugins/Git/Extensions/Terminal')
    }
  })

  it('Plugins uses the local plug icon with accessible labels', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    assert.ok(rail.includes("icon: 'plugins'"), 'rail must use the local plug icon')
    assert.ok(rail.includes('aria-label={entry.label}'), 'rail items must keep accessible labels')
    const icons = readRenderer('components/icons/StarkIcon.tsx')
    assert.ok(icons.includes("'plugins'"), 'icon set must define the plug glyph')
  })

  it('selecting Plugins opens the PLUGINS drawer with entitlement copy', () => {
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(drawer.includes("plugins: 'PLUGINS'"), 'drawer must title the plugins activity')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("activity === 'plugins'"), 'drawer must branch on the plugins activity')
    assert.ok(explorer.includes('<PluginsPanel'), 'plugins branch must render the panel')
    const panel = readRenderer('features/plugins/PluginsPanel.tsx')
    assert.ok(
      panel.includes('Plugins are available with STARK Magma, Frost, or funded Void.'),
      'Free must see the upgrade path'
    )
    assert.ok(panel.includes('Connect STARK to your apps and accounts.'), 'paid states keep the future purpose')
    assert.ok(panel.includes('Coming later.'), 'paid states mark the surface as reserved')
    assert.ok(panel.includes('aria-label="Plugins"'), 'placeholder must stay accessible')
  })

  it('Free upgrade routes to Billing while paid states stay control-free', () => {
    const explorer = codeOnly(readRenderer('features/explorer/Explorer.tsx'))
    assert.ok(explorer.includes('onNavigateBilling'), 'drawer must thread the Billing route to the panel')
    const home = codeOnly(readRenderer('pages/HomePage.tsx'))
    assert.ok(home.includes("handleOpenSettings('billing')"), 'Billing route must open Settings → Billing')
    const panel = codeOnly(readRenderer('features/plugins/PluginsPanel.tsx'))
    assert.ok(panel.includes('View Billing'), 'Free upgrade must offer the Billing route')
    assert.ok(panel.includes('productionEntitlements'), 'panel must derive the central Free default')
  })

  it('placeholder carries no fake provider surface', () => {
    const panel = codeOnly(readRenderer('features/plugins/PluginsPanel.tsx'))
    for (const fake of ['Slack', 'Discord', 'Notion', 'OAuth', 'API key', '>Connect<']) {
      assert.ok(!panel.includes(fake), `placeholder must not contain ${fake}`)
    }
    assert.ok(!panel.includes('.invoke('), 'placeholder must add no IPC')
    assert.ok(!panel.includes('fetch('), 'placeholder must make no network requests')
  })

  it('Extensions stays independent and unchanged', () => {
    const rail = codeOnly(readRenderer('features/explorer/ActivityRail.tsx'))
    assert.ok(rail.includes("kind: 'extensions'"), 'rail must keep Extensions')
    assert.ok(rail.includes("label: 'Extensions'"), 'rail must keep the Extensions label')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("activity === 'extensions'"), 'drawer must keep the extensions branch')
    assert.ok(explorer.includes('<ExtensionsPanel'), 'drawer must keep rendering the extensions panel')
  })

  it('Change Transaction core is untouched by the drawer removal', () => {
    const explorer = codeOnly(readRenderer('features/explorer/Explorer.tsx'))
    // Review-before-write pipeline stays wired in the session flow.
    for (const marker of [
      '<TransactionReview',
      '<ChangeSetReview',
      'handleAccept',
      'handleReject',
      'handleRollback',
      'changesReducer',
      'changeSetPanelReducer',
      'refreshHistory',
      'refreshChangeSets'
    ]) {
      assert.ok(explorer.includes(marker), `Explorer must keep ${marker}`)
    }
    // Review handoffs still reveal the secondary Review tab.
    assert.ok(explorer.includes("secondaryUiDispatch({ type: 'open-tab', tab: 'review' })"), 'review handoffs must still reveal Review')
    // Shared transaction surfaces still exist on disk.
    for (const file of [
      'features/changes/ChangesPanel.tsx',
      'features/changes/ChangeSetPanel.tsx',
      'features/changes/TransactionReview.tsx',
      'features/changes/changes-state.ts',
      'features/changes/change-set-state.ts'
    ]) {
      assert.ok(existsSync(join(process.cwd(), 'src', 'renderer', 'src', file)), `${file} must still exist`)
    }
  })

  it('no plugin backend surface was added', () => {
    for (const file of ['features/plugins/PluginsPanel.tsx', 'features/explorer/ActivityRail.tsx', 'layouts/WorkspaceToolsDrawer.tsx']) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC`)
    }
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
