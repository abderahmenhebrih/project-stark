import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'
import { STARK_STYLES, findStyleDefinition } from './style-registry'
import { brandPrimaryForStyleId, documentStyleId, starkEditorTheme, starkEditorThemeForPrimary } from '../editor/editor-theme'

/**
 * Magma brand-token sweep audit.
 *
 * When Magma is active, EVERY brand-lime point resolves to Magma
 * orange (#ff6a00, the existing approved orange — no second orange),
 * while semantic success green stays semantic green and magenta stays
 * the secondary accent. Logos swap to the Magma family; switching is
 * live with no reload.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function rendererFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      rendererFiles(full, out)
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.css'))) {
      out.push(full)
    }
  }
  return out
}

describe('magma brand sweep', () => {
  it('uses the existing approved Magma orange (no second orange)', () => {
    const magma = findStyleDefinition('magma')
    assert.equal(magma.primary, '#ff6a00')
    assert.equal(magma.primarySoft, 'rgba(255, 106, 0, 0.12)')
    assert.equal(magma.secondary, '#ff2ea6')
    const tokens = readRenderer('styles/tokens.css')
    const magmaBlock = tokens.split("[data-stark-style='magma']")[1]?.split('}')[0] ?? ''
    assert.ok(magmaBlock.includes('--stark-lime: #ff6a00'), 'magma primary must be the approved orange')
    assert.ok(magmaBlock.includes('--stark-accent: #ff6a00'), 'magma accent must be the approved orange')
    assert.ok(magmaBlock.includes('--stark-primary: #ff6a00'), 'central primary alias must follow magma')
    assert.ok(!magmaBlock.toLowerCase().includes('#ff7a00') && !magmaBlock.toLowerCase().includes('#ff5500'), 'no second orange may appear')
  })

  it('keeps semantic colors and magenta untouched in every style', () => {
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.includes('--stark-success: #3ddc84'), 'semantic success green must stay')
    assert.ok(tokens.includes('--stark-magenta: #ff2ea6'), 'magenta secondary must stay')
    for (const style of STARK_STYLES) {
      assert.equal(style.secondary, '#ff2ea6', `${style.id} must keep magenta secondary`)
    }
    for (const block of ["[data-stark-style='magma']", "[data-stark-style='frost']", "[data-stark-style='void']"]) {
      const body = tokens.split(block)[1]?.split('}')[0] ?? ''
      assert.ok(!body.includes('--stark-success'), `${block} must not touch semantic success`)
      assert.ok(!body.includes('--stark-magenta:'), `${block} must not touch magenta`)
    }
  })

  it('resolves representative brand surfaces through theme variables', () => {
    const session = readRenderer('features/sessions/session.css')
    assert.ok(session.includes('.session__composer:focus-within'), 'composer focus must exist')
    const focus = session.match(/\.session__composer:focus-within\s*\{[^}]*\}/)
    assert.ok(focus !== null && focus[0].includes('var(--stark-lime)'), 'composer border must resolve to the active primary')
    assert.ok(session.includes('.session__send') && session.match(/\.session__send\s*\{[^}]*var\(--stark-lime\)/) !== null, 'send control must resolve to the active primary')
    assert.ok(session.includes('.session__modepill--target'), 'target pill must carry primary styling')
    const chrome = readRenderer('layouts/AppChrome.css')
    assert.ok(chrome.includes('.app-chrome__control[aria-pressed="true"]'), 'active chrome control must exist')
    assert.ok(chrome.includes('.app-chrome__newtab:hover'), 'chrome action hover must exist')
    const global = readRenderer('styles/global.css')
    assert.ok(global.includes('var(--stark-accent)'), 'primary buttons/focus rings must resolve through the accent token')
    const live = readRenderer('features/live-review/LiveReviewPanel.css')
    assert.ok(live.includes('var(--stark-accent)'), 'Live Review primary button must follow the active style')
  })

  it('swaps to the official Magma logo assets (never CSS-recolored)', () => {
    const assets = readRenderer('features/styles/style-assets.ts')
    assert.ok(assets.includes('STARK_MAGMA_ICON_URL'), 'magma icon asset must be used')
    assert.ok(assets.includes('STARK_MAGMA_WORDMARK_URL'), 'magma wordmark asset must be used')
    assert.ok(assets.includes('STARK_MAGMA_FULL_LOGO_URL'), 'magma lockup asset must be used')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('useBrandAssets()'), 'AppChrome must resolve logos per active style')
    const chromeCss = readRenderer('layouts/AppChrome.css')
    assert.ok(!chromeCss.includes('hue-rotate'), 'logos must swap assets, never CSS-recolor')
  })

  it('tints canvas surfaces (Monaco + xterm) live from the active style', () => {
    // Monaco default stays Free lime; the style-aware mapping turns
    // every caret/selection color to the active primary.
    assert.equal(starkEditorTheme().colors['editorCursor.foreground'], '#C8FF00')
    const magmaTheme = starkEditorThemeForPrimary(brandPrimaryForStyleId('magma'))
    assert.equal(magmaTheme.colors['editorCursor.foreground'], '#FF6A00')
    assert.equal(magmaTheme.colors['editor.selectionBackground'], '#FF6A0040')
    assert.equal(magmaTheme.colors['editorBracketMatch.border'], '#FF6A0055')
    assert.equal(magmaTheme.colors['editorError.foreground'], '#F87171', 'diagnostics must stay semantic')
    assert.equal(brandPrimaryForStyleId('bogus'), '#C8FF00')
    assert.equal(documentStyleId(), 'free', 'Node (no DOM) must fail closed to free')
    const codeEditor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(codeEditor.includes('refreshStarkThemeForDocumentStyle'), 'editor must tint live to the document style')
    assert.ok(codeEditor.includes("attributeFilter: ['data-stark-style']"), 'style switches must re-tint with no remount')
    const terminal = readRenderer('features/terminal/TerminalInstanceView.tsx')
    assert.ok(terminal.includes("getPropertyValue('--stark-lime')"), 'xterm cursor must read the live primary token')
    assert.ok(terminal.includes("attributeFilter: ['data-stark-style']"), 'terminal must re-tint live with no remount')
  })

  it('switches styles live with no reload or state loss', () => {
    const provider = readRenderer('app/AppProvider.tsx')
    assert.ok(provider.includes("document.documentElement.dataset['starkStyle']"), 'style must apply as a live dataset switch')
    assert.ok(!provider.includes('location.reload'), 'switching must never reload')
  })

  it('scans source for unauthorized hard-coded brand lime', () => {
    const allowlist = new Set([
      'styles/tokens.css', // canonical token definitions
      'features/styles/style-registry.ts', // canonical style definitions
      'features/editor/editor-theme.ts', // functional default + style-aware mapping
      'features/terminal/TerminalInstanceView.tsx' // live token read + fail-closed fallback
    ])
    const offenders: string[] = []
    for (const file of rendererFiles(join(process.cwd(), 'src', 'renderer', 'src'))) {
      const relative = file.split(join('src', 'renderer', 'src') + sep)[1] ?? file
      if (relative.endsWith('.test.ts') || relative.endsWith('.test.tsx')) {
        continue
      }
      const normalized = relative.replace(/\\/g, '/')
      if (allowlist.has(normalized)) {
        continue
      }
      const content = readFileSync(file, 'utf8')
      if (/#c8ff00/i.test(content) || /200,\s*255,\s*0/.test(content)) {
        offenders.push(normalized)
      }
    }
    assert.deepEqual(offenders, [], `brand lime must flow through theme variables: ${offenders.join(', ')}`)
  })
})
