import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Installed-view layout + honesty guarantees (mini UI fix: compact
 * installed cards, real compatibility badges, honest Loaded state).
 *
 * Primary actions (Enable/Disable, Uninstall) stay visible;
 * secondary actions (Details, Run/Retry, Update) live in a compact
 * ... menu; the expandable Details surface is unchanged. Runs
 * against repository source (cwd is the repo root via npm).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

function installedRowSlice(): string {
  const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
  const start = source.indexOf('function renderInstalledRow(')
  assert.ok(start >= 0, 'renderInstalledRow must exist')
  const end = source.indexOf('\n  }\n', start)
  assert.ok(end > start, 'installed row must end')
  return source.slice(start, end)
}

describe('installed extension layout', () => {
  it('uses a compact column card: icon head, meta, status, actions', () => {
    const body = installedRowSlice()
    assert.ok(body.includes('extensions__installed-top'), 'row must group icon plus head')
    assert.ok(body.includes('extensions__installed-details'), 'head must stack identity lines')
    assert.ok(body.includes('extensions__installed-actions'), 'actions must sit below the head')
    assert.ok(!body.includes('extensions__row-actions'), 'no giant inline action row may remain')
  })

  it('keeps primary actions visible with labels', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('renderStateAction(item)'), 'Enable/Disable must stay primary')
    assert.ok(source.includes('aria-label={`Disable ${item.displayName}`}'), 'Disable must stay labelled')
    assert.ok(source.includes('aria-label={`Enable ${item.displayName}`}'), 'Enable must stay labelled')
    assert.ok(source.includes('aria-label={`Uninstall ${item.displayName}`}'), 'Uninstall must stay primary')
    assert.ok(source.includes('Uninstall {item.displayName}?'), 'uninstall confirmation must stay')
  })

  it('moves secondary actions into a compact menu with Escape + close-on-run', () => {
    const body = installedRowSlice()
    assert.ok(body.includes('More actions for'), 'overflow toggle must exist')
    assert.ok(body.includes('role="menu"'), 'menu must expose the menu role')
    assert.ok(body.includes('role="menuitem"'), 'menu entries must be menu items')
    assert.ok(body.includes("event.key === 'Escape'"), 'menu must close on Escape')
    assert.ok(body.includes('setMenuOpenKey(null)'), 'menu must close when running an action')
    for (const entry of ['Details', 'Run', 'Retry activation', 'Update to']) {
      assert.ok(body.includes(entry), `menu must offer ${entry}`)
    }
  })

  it('never shows pre-install copy on installed items', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('renderCompatibility(details, true)'), 'installed rows must take the installed branch')
    const badge = source.slice(0, source.indexOf('type ExtensionsView'))
    assert.ok(badge.includes('Compatibility unknown until installed'), 'marketplace About keeps the pre-install copy')
    const installed = source.slice(source.indexOf('function renderInstalledRow('))
    assert.ok(!installed.includes('Compatibility unknown until installed'), 'installed rows must never show it')
  })

  it('auto-resolves real compatibility badges on the installed view', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('loadDetails(item)'), 'details loader must exist')
    assert.ok(source.includes('for (const item of Object.values(installedByKey))'), 'installed items must resolve on view')
    assert.ok(source.includes('Checking compatibility…'), 'unresolved rows must say Checking')
    assert.ok(source.includes('Compatible'), 'real badge copy must exist')
    assert.ok(source.includes('Partially compatible'), 'real badge copy must exist')
    assert.ok(source.includes('Unsupported'), 'real badge copy must exist')
  })

  it('lists installed cards before utility groups', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    const list = source.indexOf('aria-label="Installed extensions"')
    assert.ok(list >= 0, 'installed list must exist')
    for (const group of ['Editor theme', 'Extension output', 'Proposed edits']) {
      const at = source.indexOf(group)
      if (at >= 0) {
        assert.ok(list < at, `installed list must precede ${group}`)
      }
    }
  })

  it('stays 392px-safe: column card, wrapping actions, ellipsized names, bounded menu', () => {
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const row = css.match(/\.extensions__installed-row\s*\{[^}]*\}/)
    assert.ok(row !== null, 'installed row CSS must exist')
    assert.ok(row[0].includes('flex-direction: column'), 'row must stack vertically')
    assert.ok(row[0].includes('overflow: hidden'), 'row must clip instead of overflowing')
    const actions = css.match(/\.extensions__installed-actions\s*\{[^}]*\}/)
    assert.ok(actions !== null && actions[0].includes('flex-wrap: wrap'), 'actions must wrap')
    const menu = css.match(/\.extensions__menu-list\s*\{[^}]*\}/)
    assert.ok(menu !== null && menu[0].includes('max-width'), 'menu must be width-bounded')
    const name = css.match(/\.extensions__installed-name\s*\{[^}]*\}/)
    assert.ok(name !== null && name[0].includes('text-overflow: ellipsis'), 'long names must ellipsize')
  })

  it('reports Loaded only from host-active ids', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('activeIds.includes('), 'Loaded must derive from host-active ids')
    assert.ok(source.includes('Enabled · Not loaded'), 'enabled-but-idle must say Not loaded')
    assert.ok(source.includes('Disabled'), 'disabled state must render')
  })
})
