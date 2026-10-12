import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { normalizeSettingsSection, SETTINGS_SECTIONS } from './settings-section'

/**
 * Settings V2 structural proof: full-page surface (no modal),
 * exactly the five locked categories defaulting to Models, honest
 * placeholders, preserved provider/security behavior, and a
 * workbench that stays mounted behind the page.
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

const SETTINGS_FILES = [
  'features/settings/SettingsPage.tsx',
  'features/settings/SettingsNav.tsx',
  'features/settings/settings-section.ts',
  'features/settings/sections/ModelsSettings.tsx',
  'features/settings/sections/models/ModelCard.tsx',
  'features/settings/sections/models/AddModelCard.tsx',
  'features/settings/sections/models/AddModelFlow.tsx',
  'features/settings/sections/models/ModelChain.tsx',
  'features/settings/sections/models/BrainChain.tsx',
  'features/settings/sections/models/HeartChain.tsx',
  'features/settings/sections/models/model-library.ts',
  'features/settings/sections/models/model-chain.ts',
  'features/settings/sections/models/model-chains-state.ts',
  'features/settings/sections/PermissionsSettings.tsx',
  'features/settings/sections/AccountSettings.tsx',
  'features/settings/sections/BillingSettings.tsx',
  'features/settings/sections/StylesSettings.tsx',
  'features/settings/sections/AboutSettings.tsx'
]

describe('settings V2 full-page surface', () => {
  it('the modal presentation is gone, including its files', () => {
    for (const gone of [
      'src/renderer/src/features/sessions/StarkSettingsSurface.tsx',
      'src/renderer/src/features/sessions/StarkSettingsSurface.css'
    ]) {
      assert.ok(!existsSync(join(process.cwd(), gone)), `${gone} must be deleted`)
    }
    const page = codeOnly(readRenderer('features/settings/SettingsPage.tsx'))
    for (const modal of ['stark-settings-overlay', 'aria-modal', 'role="dialog"', 'stark-settings__close']) {
      assert.ok(!page.includes(modal), `settings page must not contain ${modal}`)
    }
    const css = readRenderer('features/settings/SettingsPage.css')
    for (const modal of ['stark-settings-overlay', '.stark-settings {', 'rgba(4, 6, 5']) {
      assert.ok(!css.includes(modal), `settings CSS must not contain ${modal}`)
    }
  })

  it('AppChrome stays visible with settings filling the workarea', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<AppChrome'), 'chrome must render above the page')
    assert.ok(home.includes('stage-workarea'), 'page must live in the application work area')
    assert.ok(home.includes('stage-settings-host'), 'workarea must own the settings portal host')
    assert.ok(home.includes('settingsHost'), 'portal target must reach the session panel')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('createPortal'), 'settings page must portal into the workarea host')
  })

  it('navigates exactly Models/Permissions/Account/Billing/Styles/About defaulting to Models', () => {
    assert.deepEqual(
      SETTINGS_SECTIONS.map((entry) => entry.kind),
      ['models', 'permissions', 'account', 'billing', 'styles', 'about']
    )
    const meta = readRenderer('features/settings/settings-section.ts')
    for (const label of ['Models', 'Permissions', 'Account', 'Billing', 'Styles', 'About']) {
      assert.ok(meta.includes(label), `section metadata must offer ${label}`)
    }
    const nav = readRenderer('features/settings/SettingsNav.tsx')
    assert.ok(nav.includes('SETTINGS_SECTIONS'), 'nav must render the locked section list')
    assert.ok(nav.includes('settings-nav__item--active'), 'nav must mark the selected section')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes("useState<SettingsSection>('models')"), 'settings must default to Models')
    for (const retired of ["'ai'", "'heart'", "'recovery'", "'usage'", "'profile'"]) {
      assert.ok(!codeOnly(home).includes(`SettingsSection>(${retired})`), `shell must not default to ${retired}`)
    }
  })

  it('stale section values normalize to models without a migration', () => {
    assert.equal(normalizeSettingsSection('models'), 'models')
    assert.equal(normalizeSettingsSection('billing'), 'billing')
    assert.equal(normalizeSettingsSection('ai'), 'models')
    assert.equal(normalizeSettingsSection('heart'), 'models')
    assert.equal(normalizeSettingsSection('profile'), 'models')
    assert.equal(normalizeSettingsSection(undefined), 'models')
    assert.equal(normalizeSettingsSection(null), 'models')
  })

  it('old Heart/Recovery/Usage/Profile nav entries are gone', () => {
    const nav = codeOnly(readRenderer('features/settings/SettingsNav.tsx'))
    for (const retired of ['Heart', 'Recovery', 'Usage', 'Profile', "'heart'", "'usage'", "'profile'"]) {
      assert.ok(!nav.includes(retired), `settings nav must not contain ${retired}`)
    }
  })

  it('every section renders from the page', () => {
    const page = readRenderer('features/settings/SettingsPage.tsx')
    for (const section of [
      '<ModelsSettings',
      '<PermissionsSettings',
      '<AccountSettings',
      '<BillingSettings',
      '<StylesSettings',
      '<AboutSettings'
    ]) {
      assert.ok(page.includes(section), `page must render ${section}`)
    }
    assert.ok(page.includes("section === 'models'"), 'models must be a first-class section')
    assert.ok(page.includes("section === 'styles'"), 'styles must be a first-class section')
  })

  it('leaving settings returns via Back, never a modal X', () => {
    const page = readRenderer('features/settings/SettingsPage.tsx')
    assert.ok(page.includes('Back to workbench'), 'page must offer a restrained back control')
    assert.ok(!page.includes('Close settings'), 'page must not use a modal-style close')
    assert.ok(page.includes('onBack'), 'back control must return to the workbench')
  })

  it('Billing is a real product surface with honest payment boundaries', () => {
    const billing = codeOnly(readRenderer('features/settings/sections/BillingSettings.tsx'))
    for (const card of ['STARK Free', 'STARK Magma', 'STARK Frost', 'STARK Void']) {
      assert.ok(billing.includes(card), `billing must render the ${card} card`)
    }
    assert.ok(billing.includes('CURRENT'), 'Free must be marked current until real billing exists')
    assert.ok(billing.includes('Sign in to upgrade'), 'paid actions must route through Account')
    assert.ok(billing.includes('Checkout coming next'), 'payment absence must be stated honestly')
    assert.ok(!billing.includes('Billing controls will appear here'), 'placeholder copy must be retired')
    for (const backend of ['Stripe', 'checkout(', 'invoice', 'fetch(', '.invoke(']) {
      assert.ok(!billing.includes(backend), `billing must not contain ${backend}`)
    }
  })

  it('About renders real safe metadata and nothing sensitive', () => {
    const about = readRenderer('features/settings/sections/AboutSettings.tsx')
    assert.ok(about.includes('appInfo.version'), 'about must show the real version')
    assert.ok(about.includes('STARK_FULL_LOGO_URL'), 'about must show the official logo')
    assert.ok(about.includes('Your model stopped. Your work didn’t.'), 'about must carry the slogan')
    for (const secret of ['userData', 'process.env', 'machineId', 'app.getPath']) {
      assert.ok(!about.includes(secret), `about must not expose ${secret}`)
    }
  })

  it('Account is one clean surface (nickname lives on welcome, not here)', () => {
    const account = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(account.includes('<AccountSection'), 'account must mount the real sign-in state')
    assert.ok(!account.includes('<ProfileSection'), 'account must not mount the nickname editor')
    assert.ok(!account.includes('Local Profile'), 'account must not show a second identity')
    assert.ok(account.includes('View Billing'), 'account must keep the Billing route')
    const home = codeOnly(readRenderer('pages/HomePage.tsx'))
    assert.ok(home.includes('<ProfileSection'), 'welcome surface must keep the nickname preference')
    const nav = codeOnly(readRenderer('features/settings/SettingsNav.tsx'))
    assert.ok(!nav.includes('Profile'), 'profile must not remain a top-level page')
  })

  it('opening settings preserves the mounted workbench', () => {
    const home = codeOnly(readRenderer('pages/HomePage.tsx'))
    assert.ok(home.includes('stage-workarea__main'), 'workbench must wrap in a hideable container')
    assert.ok(home.includes('stage-workarea__main--hidden'), 'settings must hide (never unmount) the workbench')
    assert.ok(home.includes('<Explorer'), 'explorer must stay mounted behind settings')
    const css = readRenderer('pages/HomePage.css')
    assert.ok(css.includes('.stage-workarea__main--hidden'), 'hidden workbench must release layout')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('terminalInstances'), 'settings must not touch terminal instances')
    const explorer = codeOnly(readRenderer('features/explorer/Explorer.tsx'))
    assert.ok(!explorer.includes('SettingsPage'), 'settings page must not live inside the explorer tree')
  })

  it('terminals are never killed by opening settings', () => {
    for (const file of ['pages/HomePage.tsx', 'features/settings/SettingsPage.tsx', 'features/sessions/SessionPanel.tsx']) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('handleKillTerminal'), `${file} must not kill terminals for settings`)
      assert.ok(!source.includes('terminalKill'), `${file} must not invoke terminal kill for settings`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('settingsHost'), 'portal target must flow to the session panel without touching terminals')
  })

  it('open session state is untouched by the settings switch', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sessionNode'), 'session node must render unconditionally')
    assert.ok(!home.includes('setComposer'), 'settings must not reset the composer')
    assert.ok(!home.includes('setAttachments'), 'settings must not reset attachments')
  })

  it('Models keeps secure key handling with no secret regressions', () => {
    // Models V2 presents a library + chains; the reviewed provider
    // form lives re-housed behind the Add API key flow unchanged.
    const models = readRenderer('features/settings/sections/ModelsSettings.tsx')
    assert.ok(models.includes('<ModelCard') || models.includes('ModelCard'), 'library must render model cards')
    assert.ok(models.includes('<BrainChain'), 'page must render the Brain Chain')
    assert.ok(models.includes('<HeartChain'), 'page must render the Heart Chain')
    const flow = readRenderer('features/settings/sections/models/AddModelFlow.tsx')
    assert.ok(flow.includes('type={props.revealKey'), 'key field must stay masked by default')
    assert.ok(flow.includes("type={props.revealKey ? 'text' : 'password'}"), 'key field must stay masked by default')
    assert.ok(flow.includes("autoComplete=\"off\""), 'key field must disable autocomplete')
    assert.ok(flow.includes('Save key'), 'save must stay explicit')
    assert.ok(flow.includes('Remove key'), 'removal must stay explicit')
    assert.ok(flow.includes('Test connection'), 'connection test must stay explicit')
    assert.ok(flow.includes('Refresh models'), 'model refresh must stay explicit')
    assert.ok(flow.includes('Use model'), 'model selection must stay explicit')
    // Web-storage persistence is enforced globally by the release
    // security matrix, which scans every renderer file including this
    // settings surface.
  })

  it('no AI runtime changes ride along with the rebuild', () => {
    for (const file of [
      'features/sessions/heart-state.ts',
      'features/sessions/recovery-state.ts',
      'features/sessions/usage-state.ts',
      'features/sessions/provider-state.ts',
      'features/sessions/capabilities-state.ts'
    ]) {
      assert.ok(existsSync(join(process.cwd(), 'src', 'renderer', 'src', file)), `${file} architecture must stay intact`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const reducer of ['heartPanelReducer', 'recoveryPanelReducer', 'usagePanelReducer', 'providerPanelReducer', 'capabilityPanelReducer']) {
      assert.ok(panel.includes(reducer), `session must keep owning ${reducer}`)
    }
  })

  it('settings adds no IPC surface', () => {
    for (const file of SETTINGS_FILES) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('fetch('), `${file} must make no network requests`)
    }
  })

  it('schema remains v19 with no migration', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
