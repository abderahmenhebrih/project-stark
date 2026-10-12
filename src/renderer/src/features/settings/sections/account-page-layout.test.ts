import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Account page single-surface proof: ONE STARK Account card, no
 * Local Profile concept on this page, no duplicate plan display —
 * with auth behavior byte-identical and the nickname system alive
 * elsewhere (welcome greeting + ProfileSection).
 * Runs against repository source.
 */

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** Extracts one <button>…</button> block containing a marker label. */
function buttonWith(source: string, label: string): string {
  const at = source.indexOf(label)
  assert.ok(at >= 0, `button ${label} must exist`)
  const open = source.lastIndexOf('<button', at)
  const close = source.indexOf('</button>', at)
  assert.ok(open >= 0 && close > open, `button ${label} must be well-formed`)
  return source.slice(open, close)
}

describe('account page single surface', () => {
  it('has no Local Profile heading, avatar, or nickname editor on the Account page', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!page.includes('Local Profile'), 'page must not render a Local Profile heading')
    assert.ok(!page.includes('STARK calls you'), 'page must not render the nickname block')
    assert.ok(!page.includes('<ProfileSection'), 'page must not mount the nickname editor')
    assert.ok(!page.includes('profile-avatar'), 'page must not render a duplicate avatar')
    assert.ok(!page.includes('profile-identity'), 'page must not render a duplicate identity row')
    assert.ok(!page.includes('accountInitials'), 'page must not compute duplicate initials')
    assert.ok(!page.includes('useApp'), 'page needs no profile store wiring')
  })

  it('renders exactly one account card over the wide canvas', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!page.includes('account-grid'), 'two-column grid must be gone')
    assert.ok(page.includes('account-single'), 'page must use the single-surface wrapper')
    const cards = page.match(/className="account-card/g) ?? []
    assert.equal(cards.length, 1, 'page must render exactly one card')
    assert.ok(page.includes('<AccountSection'), 'single card must mount the auth card')
    const css = readRenderer('features/settings/sections/AccountSettings.css')
    assert.ok(css.includes('max-width: 1040px'), 'account canvas must keep the wide surface')
    assert.ok(css.includes('.account-single'), 'single wrapper must be styled')
    assert.ok(css.includes('padding: 26px'), 'card padding must stay 24-28px')
    assert.ok(!css.includes('.profile-avatar'), 'dead profile avatar CSS must be gone')
    assert.ok(!css.includes('.plan-row'), 'dead duplicate plan-row CSS must be gone')
  })

  it('has no duplicate Current plan block on the Account page', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!page.includes('Current plan'), 'layout must not duplicate the plan line (AccountSection owns it)')
    assert.ok(!page.includes('plan-row'), 'layout must not duplicate the plan row')
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const planHits = panel.match(/Current plan: STARK Free/g) ?? []
    assert.equal(planHits.length, 1, 'signed-in identity must render the plan exactly once')
  })

  it('signed-in identity still renders real OAuth name/email/provider', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Signed in with'), 'identity must name the provider')
    assert.ok(panel.includes('accountProviderLabel(status.account.provider)'), 'provider label must stay dynamic')
    assert.ok(panel.includes('status.account.displayName'), 'real OAuth display name must render')
    assert.ok(panel.includes('status.account.email'), 'real OAuth email must render')
    assert.ok(panel.includes('Current plan: STARK Free'), 'identity must keep the plan line')
    assert.ok(panel.includes('Your Workspace files and coding history remain local'), 'local-first copy must remain')
    assert.ok(panel.includes('STARK does not sync project data to the cloud'), 'cloud boundary copy must name STARK')
    assert.ok(!panel.includes('Stage 29 does not sync'), 'stale stage copy must be gone')
  })

  it('View Billing remains inside the main surface with safe routing', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(page.includes('View Billing'), 'single surface must offer View Billing')
    assert.ok(page.includes('onNavigateBilling'), 'Billing link must use safe routing')
    assert.ok(page.includes('account-actions'), 'billing action must sit inside the single surface')
    const billingButton = buttonWith(page, 'View Billing')
    assert.ok(billingButton.includes('explorer__secondary'), 'billing must keep the secondary style')
  })

  it('Sign out remains owned by the untouched auth card', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Sign out'), 'auth card must keep Sign out')
    assert.ok(panel.includes('handleSignOut'), 'sign-out behavior must be untouched')
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!page.includes('handleSignOut'), 'layout must not duplicate sign-out logic')
  })

  it('signed-out Google/GitHub buttons remain neutral and full-width', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('account-providers'), 'providers must share a layout row')
    for (const label of ['Continue with Google', 'Continue with GitHub']) {
      const button = buttonWith(panel, label)
      assert.ok(button.includes('account-provider'), `${label} must use the neutral provider class`)
      assert.ok(!button.includes('stark-btn--primary'), `${label} must not use the lime primary class`)
    }
    const css = readRenderer('features/settings/sections/AccountSettings.css')
    assert.ok(css.includes('min-height: 50px'), 'provider buttons must stay 48-52px high')
    assert.ok(css.includes('repeat(auto-fit, minmax(180px, 1fr))'), 'providers must use the full width gracefully')
  })

  it('nickname/onboarding system elsewhere is untouched', () => {
    assert.ok(existsSync(join(process.cwd(), 'src', 'renderer', 'src', 'features', 'profile', 'ProfileSection.tsx')), 'ProfileSection must still exist')
    const home = codeOnly(readRenderer('pages/HomePage.tsx'))
    assert.ok(home.includes('<ProfileSection'), 'welcome surface must keep the nickname editor')
    assert.ok(home.includes('What are we building today?'), 'session greeting must keep the nickname')
    const profile = codeOnly(readRenderer('features/profile/ProfileSection.tsx'))
    assert.ok(profile.includes('STARK calls you'), 'nickname component copy must be untouched')
    assert.ok(profile.includes('updateLocalDisplayName'), 'nickname save path must be untouched')
  })

  it('loading and error states render inside the single Account card', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('Checking account…'), 'loading copy must remain')
    assert.ok(panel.includes('sign-in could not be completed.'), 'sanitized error must remain')
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(page.includes('account-card'), 'card chrome persists across state swaps')
  })

  it('changes no auth logic, IPC, or schema', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes("handleStart('google')"), 'Google flow must be untouched')
    assert.ok(panel.includes("handleStart('github')"), 'GitHub flow must be untouched')
    assert.ok(panel.includes('accountPanelReducer'), 'panel state must be untouched')
    for (const file of [
      'features/settings/sections/AccountSettings.tsx',
      'features/settings/sections/AccountSettings.css',
      'features/account/AccountSection.tsx'
    ]) {
      const source = codeOnly(readRenderer(file))
      assert.ok(!source.includes('.invoke('), `${file} must add no IPC invokes`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('fetch('), `${file} must make no network requests`)
    }
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(!page.includes('magma') && !page.includes('frost'), 'page must fabricate no paid state')
  })
})
