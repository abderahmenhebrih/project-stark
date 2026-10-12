import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Single-AppChrome invariant: exactly one in-window application bar
 * (the STARK AppChrome) on every surface. The native File/Edit/View/
 * Window menu is removed on Windows/Linux (macOS keeps its OS-level
 * system menu, which never renders inside content), and Settings
 * keeps only its content header — never a second toolbar.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

function readMain(relative: string): string {
  return readSource('src', 'main', ...relative.split('/'))
}

describe('single application chrome', () => {
  it('removes the native menu on Windows/Linux and keeps macOS intact', () => {
    const index = readMain('index.ts')
    assert.ok(index.includes('configureNativeApplicationMenu'), 'startup must configure the native menu policy')
    assert.ok(index.includes('Menu.setApplicationMenu'), 'policy must null the application menu')
    const policy = readMain('windows/app-menu.ts')
    assert.ok(policy.includes("platform !== 'darwin'"), 'macOS must keep its system menu')
    assert.ok(policy.includes('setApplicationMenu(null)'), 'other platforms must drop the native menu')
  })

  it('creates no second menu surface anywhere in main', () => {
    const window = readMain('windows/app-window.ts')
    assert.ok(!window.includes('Menu.setApplicationMenu'), 'window creation must not build menus')
    assert.ok(!window.includes('buildFromTemplate'), 'no menu templates may exist')
    assert.ok(window.includes('autoHideMenuBar: true'), 'auto-hide stays as a backstop')
  })

  it('settings keeps a content header, never a second app bar', () => {
    const settings = readRenderer('features/settings/SettingsPage.tsx')
    assert.ok(settings.includes('Back'), 'settings keeps its Back affordance')
    assert.ok(settings.includes('>Settings<'), 'settings keeps its content title')
    assert.ok(!settings.includes('AppChrome'), 'settings must not mount another chrome')
    assert.ok(!settings.includes('menu bar') && !settings.includes('menubar'), 'no native menu bar may exist in settings')
    const css = readRenderer('features/settings/SettingsPage.css')
    assert.ok(css.includes('.settings-page__head'), 'settings header must be a content header')
    assert.ok(!css.includes('position: fixed'), 'settings header must live in normal content flow')
  })

  it('every workbench surface shares the one AppChrome', () => {
    const home = readRenderer('pages/HomePage.tsx')
    const matches = home.match(/<AppChrome/g) ?? []
    assert.equal(matches.length, 1, 'shell must render exactly one AppChrome')
    for (const surface of ['Session', 'Settings', 'Explorer', 'Search', 'Git', 'Extensions', 'Terminal', 'Live Review']) {
      assert.ok(!readRenderer('pages/HomePage.tsx').includes(`<AppChrome ${surface}`), `no per-surface chrome for ${surface}`)
    }
  })
})
