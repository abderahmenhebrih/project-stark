import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

function readRenderer(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'src', relative), 'utf8')
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('styles theme application', () => {
  it('theme state lives beside workbench state without unmounting it', () => {
    const provider = codeOnly(readRenderer('app/AppProvider.tsx'))
    assert.ok(provider.includes('brandStyleId'), 'provider must own the style slice')
    assert.ok(provider.includes('document.documentElement'), 'style must apply via a document attribute')
    assert.ok(!provider.includes('location.reload'), 'style change must never reload')
    for (const forbidden of ['terminalKill', 'handleKillTerminal', 'setComposer', 'setAttachments']) {
      assert.ok(!provider.includes(forbidden), `style state must not touch ${forbidden}`)
    }
    const home = codeOnly(readRenderer('pages/HomePage.tsx'))
    assert.ok(home.includes('stage-workarea__main--hidden'), 'workbench must hide, never unmount')
  })

  it('AppChrome swaps icon and wordmark with identical geometry', () => {
    const chrome = codeOnly(readRenderer('layouts/AppChrome.tsx'))
    assert.ok(chrome.includes('useBrandAssets'), 'chrome must read style-aware brand assets')
    assert.ok(chrome.includes('brand.iconUrl'), 'chrome emblem must follow the style')
    assert.ok(chrome.includes('brand.wordmarkUrl'), 'chrome wordmark must follow the style')
    assert.ok(chrome.includes('alt="STARK"'), 'wordmark must keep alt="STARK"')
    const css = readRenderer('layouts/AppChrome.css')
    const wordmark = css.match(/\.app-chrome__wordmark\s*\{[^}]*\}/)
    assert.ok(wordmark !== null, 'wordmark CSS must exist')
    assert.ok(wordmark[0].includes('height:') && wordmark[0].includes('object-fit: contain'), 'geometry must be preserved')
  })

  it('empty-session watermark follows the style with identical treatment', () => {
    const panel = codeOnly(readRenderer('features/sessions/SessionPanel.tsx'))
    assert.ok(panel.includes('brandWordmarkUrl'), 'watermark must follow the style')
    assert.ok(panel.includes('className="session__watermark"'), 'watermark class must be unchanged')
  })

  it('semantic colors survive every style override', () => {
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.toLowerCase().includes('--stark-success: #3ddc84'), 'success must stay semantic')
    assert.ok(tokens.toLowerCase().includes('--stark-warning: #fbbf24'), 'warning must stay semantic')
    assert.ok(tokens.toLowerCase().includes('--stark-danger: #f87171'), 'danger must stay semantic')
    assert.ok(tokens.toLowerCase().includes('--stark-lime: #c8ff00'), 'Free lime base must stay #c8ff00')
    assert.ok(tokens.toLowerCase().includes('--stark-magenta: #ff2ea6'), 'magenta must stay #ff2ea6')
    const overrides = tokens.split("[data-stark-style='magma']")[1] ?? ''
    for (const semantic of ['--stark-success', '--stark-warning', '--stark-danger', '--stark-magenta']) {
      assert.ok(!overrides.includes(semantic), `style overrides must not touch ${semantic}`)
    }
  })

  it('Styles page shows four cards with locked states and no spoofing', () => {
    const page = codeOnly(readRenderer('features/settings/sections/StylesSettings.tsx'))
    assert.ok(page.includes('STARK_STYLES'), 'page must render the registry styles')
    assert.ok(page.includes('Current style'), 'active style must be marked')
    assert.ok(page.includes('Apply style'), 'unlocked styles must offer apply')
    assert.ok(page.includes('Unlocks permanently on your first Void reload'), 'Void requirement must be stated')
    assert.ok(!page.includes('devFixtureProductState'), 'page must not wire dev fixtures')
    assert.ok(!page.includes('Become Frost'), 'page must offer no plan spoofing')
    const css = readRenderer('features/settings/sections/StylesSettings.css')
    assert.ok(css.includes('.styles-grid'), 'styles grid CSS must exist')
    assert.ok(css.includes('.styles-card'), 'style card CSS must exist')
  })

  it('style persists through the main-owned settings store (no migration)', () => {
    const root = join(process.cwd(), 'src')
    const schema = codeOnly(readFileSync(join(root, 'main', 'settings', 'settings-schema.ts'), 'utf8'))
    assert.ok(schema.includes('brandStyle'), 'settings schema must persist the style')
    const shared = readFileSync(join(root, 'shared', 'settings', 'types.ts'), 'utf8')
    assert.ok(shared.includes('BrandStyleId'), 'shared settings must type the style')
    assert.ok(shared.includes("brandStyle: BrandStyleId"), 'settings record must carry the style')
  })
})
