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
    const badge = source.slice(0, source.indexOf('type ExtensionsView'))
    assert.ok(badge.includes('Compatibility unknown until installed'), 'marketplace About keeps the pre-install copy')
    const installed = source.slice(source.indexOf('function renderInstalledRow('))
    assert.ok(!installed.includes('Compatibility unknown until installed'), 'installed rows must never show it')
  })

  it('keeps diagnostics out of the card: compact state word, reasons in Details only', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    const rowStart = source.indexOf('function renderInstalledRow(')
    const drawerAt = source.indexOf('{selectedKey === key &&', rowStart)
    assert.ok(rowStart >= 0 && drawerAt > rowStart, 'row must own a Details drawer')
    const card = source.slice(rowStart, drawerAt)
    assert.ok(card.includes('installedStatusCopy'), 'card status must come from the compact helper')
    assert.ok(!card.includes('extensions__reasons'), 'no diagnostic bullet list may render in the card')
    assert.ok(!card.includes('Partially compatible'), 'no compat badge copy may render in the card')
    assert.ok(!card.includes('Update available:'), 'no update line may render in the card')
    const helper = source.slice(source.indexOf('function installedStatusCopy('), rowStart)
    assert.ok(helper.includes('Needs attention'), 'incompatible extensions collapse to a compact state')
    assert.ok(helper.includes('Enabled · Loaded'), 'loaded truth must survive the compact state')
    assert.ok(source.includes('{renderCompatibility(details)}'), 'Details must own the compat badge')
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
    for (const group of ['Editor theme', 'Extension output', 'Proposed edits', 'Extension management']) {
      const at = source.indexOf(group)
      if (at >= 0) {
        assert.ok(list < at, `installed list must precede ${group}`)
      }
    }
  })

  it('keeps management utilities compact below the list', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    const management = source.indexOf('Extension management')
    assert.ok(management >= 0, 'management section must exist')
    const section = source.slice(management, management + 1200)
    assert.ok(section.includes('extensions__management'), 'utilities must use the compact container')
    for (const control of ['Disable all', 'Enable all', 'Check workspace', 'Automatically update extensions']) {
      assert.ok(section.includes(control) || source.includes(control), `${control} must stay available`)
    }
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    assert.ok(css.includes('.extensions__management'), 'management CSS must exist')
  })

  it('resets icon failure state when the icon URL changes (no stale fallback)', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    const iconFn = source.slice(source.indexOf('function ExtensionIcon('), source.indexOf('function CompatBadge('))
    assert.ok(iconFn.includes('failedUrl'), 'failure must be recorded per URL')
    assert.ok(iconFn.includes('failedUrl === iconUrl'), 'a new URL must read as unfailure')
    assert.ok(iconFn.includes('setFailedUrl(iconUrl)'), 'errors must pin the failing URL')
  })

  it('Enable/Disable use the STARK secondary control', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    const stateAction = source.slice(source.indexOf('function renderStateAction('), source.indexOf('function handleRun('))
    assert.ok(stateAction.includes('className="extensions__secondary"'), 'Enable/Disable must use the STARK button class')
    assert.ok(!stateAction.includes('className="extensions__uninstall"'), 'primary action must not wear destructive paint')
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const secondary = css.match(/\.extensions__secondary\s*\{[^}]*\}/)
    assert.ok(secondary !== null, 'STARK secondary rule must exist')
    assert.ok(secondary[0].includes('var(--stark-border)'), 'secondary must use the STARK border token')
    assert.ok(secondary[0].includes('var(--stark-radius-sm)'), 'secondary must use the STARK radius token')
  })

  it('Uninstall uses a restrained STARK destructive style, never native', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('className="extensions__uninstall"'), 'Uninstall must use the destructive class')
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const uninstall = css.match(/\.extensions__uninstall\s*\{[^}]*\}/)
    assert.ok(uninstall !== null, 'destructive rule must exist (unstyled buttons render browser-native)')
    for (const token of ['var(--stark-text)', 'var(--stark-border)', 'var(--stark-radius-sm)']) {
      assert.ok(uninstall[0].includes(token), `destructive base must use ${token}`)
    }
    const hover = css.match(/\.extensions__uninstall:hover[^{]*\{[^}]*\}/)
    assert.ok(hover !== null && hover[0].includes('var(--stark-danger)'), 'hover must turn destructive red')
    assert.ok(!hover[0].includes('#fff') && !hover[0].includes('white'), 'hover must never be bright native white')
  })

  it('overflow and checkbox controls use STARK styling', () => {
    const source = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(source.includes('className="extensions__menu-toggle"'), 'overflow must use the styled toggle')
    assert.ok(source.includes('className="extensions__menu-item"'), 'menu actions must use the styled item')
    assert.ok(source.includes('className="extensions__checkbox"'), 'checkboxes must use the STARK control class')
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    const toggle = css.match(/\.extensions__menu-toggle\s*\{[^}]*\}/)
    assert.ok(toggle !== null && toggle[0].includes('background'), 'overflow toggle must paint explicitly')
    const checkbox = css.match(/\.extensions__checkbox\s*\{[^}]*\}/)
    assert.ok(checkbox !== null, 'STARK checkbox rule must exist')
    assert.ok(checkbox[0].includes('appearance: none'), 'checkbox must replace native paint')
    const checked = css.match(/\.extensions__checkbox:checked\s*\{[^}]*\}/)
    assert.ok(checked !== null && checked[0].includes('var(--stark-lime)'), 'checked state must use STARK lime')
  })

  it('installed buttons share one height/radius language at 392px', () => {
    const css = readRenderer('features/extensions/ExtensionsPanel.css')
    for (const rule of ['.extensions__secondary', '.extensions__uninstall']) {
      const match = css.match(new RegExp(`${rule.replace(/\./g, '\\.')}\\s*\\{[^}]*\\}`))
      assert.ok(match !== null, `${rule} must exist`)
      assert.ok(match[0].includes('min-height: 30px'), `${rule} must share the 30px control height`)
      assert.ok(match[0].includes('border-radius: var(--stark-radius-sm)'), `${rule} must share the STARK radius`)
      assert.ok(match[0].includes(':focus-visible') || css.includes(`${rule}:focus-visible`), `${rule} must expose focus styling`)
    }
    const row = css.match(/\.extensions__installed-row\s*\{[^}]*\}/)
    assert.ok(row !== null && row[0].includes('overflow: hidden'), 'card must clip instead of overflowing')
    assert.ok(row[0].includes('max-width: 100%'), 'card must stay within 392px')
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

  it('Loaded reflects the live host active set on both sides of IPC', () => {
    // Renderer half: activeIds feeds purely from listActiveExtensions.
    const panel = readRenderer('features/extensions/ExtensionsPanel.tsx')
    assert.ok(panel.includes('listActiveExtensions'), 'renderer must load the live active set')
    assert.ok(panel.includes('refreshActive()'), 'active set must refresh on view and state changes')
    // Main half: the active set is recorded only on a successful
    // host activation reply, and details read it live.
    const activation = readRenderer('../../main/extension-host/extension-activation-service.ts')
    assert.ok(activation.includes('this.active.set(id,'), 'active must record on host-confirmed activation')
    assert.ok(activation.includes('EXTENSION_ACTIVATED'), 'activation must settle on the host reply')
    const runtime = readRenderer('../../main/extension-host/extension-runtime-service.ts')
    assert.ok(
      runtime.includes('active: this.activationService.listActive().includes(id)'),
      'details must read the live active set, never a cached flag'
    )
  })
})
