import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * STARK STAGE 31 MANUAL REVIEW FIX 05 — official brand assets.
 *
 * Proves the CSS-generated placeholder is retired and the real raster
 * assets (src/public/starkicon.png, starkword.png, fullstark.png) are
 * the production branding through Vite-bundled renderer URLs.
 * Renderer branding only — no main/preload/IPC/schema changes.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('D05 official STARK brand assets', () => {
  it('actual asset files are present with real extensions', () => {
    for (const file of ['starkicon.png', 'starkword.png', 'fullstark.png']) {
      const full = join(process.cwd(), 'src', 'public', file)
      assert.ok(existsSync(full), `src/public/${file} must exist (actual extension .png)`)
      assert.ok(statSync(full).size > 0, `src/public/${file} must be non-empty`)
    }
  })

  it('brand asset module exposes Vite-bundled packaged URLs', () => {
    const module = readRenderer('components/brandAssets.ts')
    assert.ok(module.includes('STARK_ICON_URL'), 'must export STARK_ICON_URL')
    assert.ok(module.includes('STARK_WORDMARK_URL'), 'must export STARK_WORDMARK_URL')
    assert.ok(module.includes('STARK_FULL_LOGO_URL'), 'must export STARK_FULL_LOGO_URL')
    assert.ok(module.includes('../../../public/starkicon.png'), 'icon must resolve from src/public/starkicon.png')
    assert.ok(module.includes('../../../public/starkword.png'), 'wordmark must resolve from src/public/starkword.png')
    assert.ok(module.includes('../../../public/fullstark.png'), 'full logo must resolve from src/public/fullstark.png')
    assert.ok(!module.includes('C:'), 'no absolute Windows path in brand module')
    assert.ok(!module.includes('http://') && !module.includes('https://'), 'no remote logo URL')
  })

  it('StarkMark renders the real starkicon asset, not the CSS placeholder', () => {
    const mark = readRenderer('components/StarkMark.tsx')
    assert.ok(mark.includes('STARK_ICON_URL'), 'StarkMark must default to the real starkicon asset')
    assert.ok(mark.includes('<img'), 'StarkMark must render an <img>')
    assert.ok(!mark.includes('stark-mark__fallback'), 'old CSS placeholder must not be rendered in production branding')
    const css = readRenderer('components/StarkMark.css')
    assert.ok(!css.includes('stark-mark__fallback'), 'placeholder fallback CSS must be removed')
    assert.ok(!css.includes('linear-gradient(135deg, var(--stark-lime)'), 'temporary gradient block must be removed')
    assert.ok(css.includes('object-fit: contain'), 'asset must use object-fit: contain without stretching')
    assert.ok(!css.includes('filter:'), 'no CSS filters may recolor the raster asset')
  })

  it('AppChrome uses icon + wordmark and fits the existing bar height', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('<StarkMark'), 'chrome must keep the StarkMark emblem slot (now the real icon)')
    assert.ok(chrome.includes('STARK_WORDMARK_URL'), 'chrome must render the official starkword asset')
    assert.ok(!chrome.includes('<span className="app-chrome__wordmark">STARK</span>'), 'plain-text wordmark must be replaced by the branded image')
    assert.ok(chrome.includes('app-chrome__tab-dot'), 'session tab keeps its small magenta identity dot')
    assert.ok(!chrome.includes('fullstark') && !chrome.includes('STARK_FULL_LOGO_URL'), 'full logo must not be forced into the compact tab or top bar')
    const css = readRenderer('layouts/AppChrome.css')
    assert.ok(css.includes('max-height: 64px'), 'top bar must stand 60–64px tall')
    const wordmark = css.match(/\.app-chrome__wordmark\s*\{[^}]*\}/)
    assert.ok(wordmark !== null, 'wordmark image CSS must exist')
    const height = wordmark[0].match(/height:\s*(\d+)px/)
    assert.ok(height !== null, 'wordmark image must declare a height')
    const heightPx = Number(height[1])
    assert.ok(heightPx >= 24 && heightPx <= 28, `chrome branding height must sit in 24–28px, got ${heightPx}px`)
    assert.ok(wordmark[0].includes('object-fit: contain'), 'wordmark must preserve aspect ratio')
    assert.ok(!wordmark[0].includes('filter:'), 'no CSS filter on the wordmark')
    assert.ok(!css.includes('.app-chrome__wordmark') || !css.includes('letter-spacing: 0.3em'), 'dead text-wordmark rules must be removed')
    assert.ok(chrome.includes('alt="STARK"'), 'wordmark image must carry alt="STARK"')
  })

  it('assistant identity uses starkicon at a small size with the STARK role label', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes("<StarkMark size=\"bar\""), 'assistant rows must render starkicon via StarkMark')
    assert.ok(panel.includes("'STARK'") || panel.includes('"STARK"'), 'assistant role label must stay STARK')
    const roleStart = panel.indexOf("<StarkMark size=\"bar\"")
    const roleSlice = panel.slice(roleStart, roleStart + 400)
    assert.ok(!roleSlice.includes('STARK_WORDMARK_URL') && !roleSlice.includes('STARK_FULL_LOGO_URL'), 'no wordmark beside every assistant message')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__message--assistant .session__role'), 'assistant role label keeps its subtle magenta accent')
  })

  it('empty/welcome state uses official assets, never the CSS fallback', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<StarkMark size="hero"'), 'empty state emblem must use the real starkicon')
    assert.ok(explorer.includes('STARK_WORDMARK_URL'), 'empty state must show the official wordmark instead of plain text')
    assert.ok(!explorer.includes('editor-empty__brand'), 'temporary text-brand placeholder must be gone')
    const editorCss = readRenderer('features/editor/editor.css')
    assert.ok(!editorCss.includes('.editor-empty__brand'), 'dead empty-brand text CSS must be removed')
    assert.ok(editorCss.includes('.editor-empty__wordmark'), 'empty wordmark image must be styled')
    const onboarding = readRenderer('features/onboarding/OnboardingPage.tsx')
    assert.ok(onboarding.includes('STARK_FULL_LOGO_URL'), 'welcome/onboarding must use the official full logo')
    assert.ok(onboarding.includes('alt="STARK"'), 'welcome brand image must carry alt="STARK"')
  })

  it('Settings About uses the full logo at a restrained width', () => {
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(surface.includes('STARK_FULL_LOGO_URL'), 'About must render the official full logo')
    assert.ok(surface.includes('alt="STARK"'), 'About brand image must carry alt="STARK"')
    assert.ok(surface.includes('appInfo.version') || surface.includes('v${appInfo.version}'), 'version/platform must stay below the logo')
    const css = readRenderer('features/sessions/StarkSettingsSurface.css')
    const logo = css.match(/\.stark-settings__about-logo\s*\{[^}]*\}/)
    assert.ok(logo !== null, 'About logo CSS must exist')
    const width = logo[0].match(/width:\s*(\d+)px/)
    assert.ok(width !== null, 'About logo must declare a restrained width')
    const widthPx = Number(width[1])
    assert.ok(widthPx >= 180 && widthPx <= 260, `About logo must sit in 180–260px, got ${widthPx}px`)
    assert.ok(logo[0].includes('object-fit: contain'), 'About logo must preserve aspect ratio')
  })

  it('no absolute Windows path or remote logo URL in renderer code', () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src')
    const files = walk(root)
    assert.ok(files.length > 10, 'renderer sources must be scanned')
    // Build forbidden drive patterns dynamically so this test file itself
    // does not trip the scanner with a literal example.
    const backslash = String.fromCharCode(92)
    const winDriveBack = `${String.fromCharCode(67)}:${backslash}${String.fromCharCode(85)}sers`
    const winDriveSlash = `${String.fromCharCode(67)}:/${String.fromCharCode(85)}sers`
    for (const file of files) {
      if (file.endsWith('brand-assets.test.ts')) {
        continue
      }
      const content = readFileSync(file, 'utf8')
      assert.ok(!content.includes(winDriveBack) && !content.includes(winDriveSlash), `${file} must not contain an absolute Windows path`)
      for (const line of content.split('\n')) {
        if (/starkicon|starkword|fullstark/i.test(line)) {
          assert.ok(!line.includes('http://') && !line.includes('https://'), `${file} must not load brand assets remotely`)
        }
      }
    }
  })

  it('renderer branding adds no IPC surface and keeps official brand colors', () => {
    for (const file of [
      'components/brandAssets.ts',
      'components/StarkMark.tsx',
      'layouts/AppChrome.tsx',
      'features/explorer/Explorer.tsx',
      'features/sessions/SessionPanel.tsx',
      'features/sessions/StarkSettingsSurface.tsx',
      'features/onboarding/OnboardingPage.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('dangerouslySetInnerHTML'), `${file} must not render raw HTML`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.toLowerCase().includes('--stark-lime: #c8ff00'), 'lime token must stay #c8ff00')
    assert.ok(tokens.toLowerCase().includes('--stark-magenta: #ff2ea6'), 'magenta token must stay #ff2ea6')
  })

  it('no new IPC and schema remains v18 with main/preload renderer-only', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('018-cloud-account.ts'), 'migration 018 must exist (schema v18)')
    assert.ok(!files.some((file) => file.startsWith('019')), 'no migration 019 may appear for a branding pass')
    const index = readSource('src', 'main', 'database', 'migrations', 'index.ts')
    assert.ok(!index.includes('019'), 'migration registry must stay at v18')
    for (const area of ['main', 'preload']) {
      const root = join(process.cwd(), 'src', area)
      const sources = walk(root)
      for (const file of sources) {
        const content = readFileSync(file, 'utf8')
        assert.ok(!/starkicon|starkword|fullstark/i.test(content), `${file} must stay untouched by renderer branding`)
      }
    }
  })
})
