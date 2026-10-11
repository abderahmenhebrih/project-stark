import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Account page layout proof (visual-only pass): two structural cards
 * over the wide content canvas, neutral OAuth controls, organized
 * profile + plan summary — with auth behavior byte-identical.
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

describe('account page layout', () => {
  it('uses two structural cards over the wide canvas', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(page.includes('account-grid'), 'page must use the two-column grid')
    const cards = page.match(/className="account-card"/g) ?? []
    assert.equal(cards.length, 2, 'page must render exactly two cards')
    assert.ok(page.includes('<AccountSection'), 'left card must mount the auth card')
    assert.ok(page.includes('Local Profile'), 'right card must be headed Local Profile')
    assert.ok(page.includes('<ProfileSection'), 'right card must absorb the display-name preference')
    const css = readRenderer('features/settings/sections/AccountSettings.css')
    assert.ok(css.includes('max-width: 1040px'), 'account canvas must use ~1000-1100px')
    assert.ok(css.includes('1.1fr 0.9fr'), 'desktop grid must weight account over profile')
    assert.ok(css.includes('gap: 22px'), 'card gap must be 20-24px')
    assert.ok(css.includes('padding: 26px'), 'card padding must be 24-28px')
  })

  it('collapses to a single column on narrow widths', () => {
    const css = readRenderer('features/settings/sections/AccountSettings.css')
    assert.ok(css.includes('@media (max-width: 900px)'), 'grid must stack on narrow widths')
    assert.ok(css.includes('grid-template-columns: 1fr'), 'stacked grid must be single-column')
    assert.ok(css.includes('repeat(auto-fit, minmax(180px, 1fr))'), 'provider buttons must wrap gracefully')
  })

  it('renders provider controls as neutral full-width buttons', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('account-providers'), 'providers must share a layout row')
    for (const label of ['Continue with Google', 'Continue with GitHub']) {
      const button = buttonWith(panel, label)
      assert.ok(button.includes('account-provider'), `${label} must use the neutral provider class`)
      assert.ok(!button.includes('stark-btn--primary'), `${label} must not use the lime primary class`)
      assert.ok(!button.includes('stark-btn--secondary'), `${label} must not use action button classes`)
    }
    const css = readRenderer('features/settings/sections/AccountSettings.css')
    assert.ok(css.includes('min-height: 50px'), 'provider buttons must be 48-52px high')
    assert.ok(css.includes('.account-provider:disabled'), 'disabled state must be styled')
  })

  it('disabled providers are muted without lime', () => {
    const css = codeOnly(readRenderer('features/settings/sections/AccountSettings.css'))
    const at = css.indexOf('.account-provider:disabled')
    assert.ok(at >= 0, 'disabled rule must exist')
    const rule = css.slice(at, at + 300)
    assert.ok(rule.includes('opacity: 0.45'), 'disabled providers must be muted')
    assert.ok(rule.includes('not-allowed'), 'disabled providers must show a blocked cursor')
    assert.ok(!rule.includes('lime'), 'disabled providers must never use lime')
  })

  it('keeps the not-configured notice calm and the local-data footer', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    assert.ok(panel.includes('account-notice'), 'notice must use the calm status block')
    assert.ok(panel.includes('Account sign-in is not configured for this build.'), 'notice copy must remain')
    assert.ok(panel.includes('account-note'), 'local-data line must live in the card footer')
    const css = codeOnly(readRenderer('features/settings/sections/AccountSettings.css'))
    const at = css.indexOf('.account-notice')
    const rule = css.slice(at, at + 300)
    assert.ok(!rule.includes('red') && !rule.includes('danger'), 'notice must not be error-red')
  })

  it('Local Profile card shows avatar, name, edit, and plan', () => {
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(page.includes('profile-avatar'), 'profile card must show the initial avatar')
    assert.ok(page.includes('profile-identity'), 'avatar and name must share an identity row')
    assert.ok(page.includes('plan-row'), 'plan summary must be a separated row')
    assert.ok(page.includes('Current plan'), 'plan row must be labeled')
    assert.ok(page.includes('STARK Free'), 'plan must stay honestly Free')
    assert.ok(page.includes('View Billing'), 'plan row may link to Billing')
    assert.ok(page.includes("onSectionChange('billing')") || page.includes('onNavigateBilling'), 'Billing link must use safe routing')
  })

  it('signed-in state still hides provider buttons with profile separate', () => {
    const panel = codeOnly(readRenderer('features/account/AccountSection.tsx'))
    const tail = panel.slice(panel.indexOf("if (status.state === 'session_attention'"))
    assert.ok(!tail.includes('Continue with'), 'signed-in states must hide sign-in buttons')
    assert.ok(tail.includes('Current plan: STARK Free'), 'identity card must keep the plan line')
    const page = codeOnly(readRenderer('features/settings/sections/AccountSettings.tsx'))
    assert.ok(page.includes('<ProfileSection'), 'local profile stays independent from OAuth identity')
  })

  it('loading and error states render inside the Account card', () => {
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
