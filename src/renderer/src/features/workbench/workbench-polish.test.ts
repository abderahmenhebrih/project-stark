import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 frontend shell regression: one global bar above a primary
 * session pane + contextual secondary pane (Review | Context | file
 * with a stacked terminal), an overlay workspace-tools drawer, a thin
 * status strip, and a dedicated settings surface. Official brand is
 * obsidian + neon lime (primary) + neon magenta (AI accent); repo
 * green is semantic-only. All behavior preserved; renderer-only.
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

describe('stage 31 frontend shell', () => {
  it('one global bar carries identity; no stacked toolbars', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('<AppChrome'), 'shell must render one global bar')
    assert.ok(!home.includes('workbench-top'), 'stacked header rows must be retired')
    assert.ok(!home.includes('workbench-main'), 'triple-column main must be retired')
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('<StarkMark'), 'global bar must carry the STARK identity')
    assert.ok(chrome.includes('workspaceName'), 'global bar must carry the workspace identity')
    assert.ok(chrome.includes('workspacePath'), 'path must stay available as muted metadata')
    assert.ok(!chrome.includes('FOUNDATION'), 'unfinished foundation chrome must be gone')
    assert.ok(chrome.includes('Search workspace'), 'workspace search must stay in the chrome')
    assert.ok(!chrome.includes('☰'), 'chrome must use SVG icons, not glyphs')
    const shell = readRenderer('layouts/MainLayout.tsx')
    assert.ok(!shell.includes('shell__header'), 'shell must not stack a second toolbar')
    assert.ok(!shell.includes('FOUNDATION'), 'shell must not render foundation copy')
  })

  it('tools drawer overlays on demand with the activity selector', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const activity of ['explorer', 'search', 'changes', 'git']) {
      assert.ok(rail.includes(activity), `drawer must offer the ${activity} activity`)
    }
    assert.ok(rail.includes('aria-selected'), 'drawer must expose selection')
    assert.ok(rail.includes('title='), 'drawer must tooltip its icon-first controls')
    assert.ok(!rail.includes('▤'), 'rail must use SVG icons, not glyphs')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<WorkspaceToolsDrawer'), 'shell must render the drawer')
    assert.ok(explorer.includes('onCloseSidebar'), 'drawer must be closable')
    const css = readRenderer('features/explorer/Explorer.css')
    const drawer = css.match(/\.workspace-tools-drawer\s*\{[^}]*\}/)
    assert.ok(drawer !== null, 'drawer CSS must exist')
    assert.ok(drawer[0].includes('position: absolute'), 'drawer must overlay instead of consuming a column')
    const active = css.match(/\.explorer__tab--active\s*\{[^}]*\}/)
    assert.ok(active !== null, 'selected activity state must exist')
    assert.ok(!active[0].includes('background: var(--stark-lime);'), 'selection must be an indicator, not a neon block')
  })

  it('session conversation stays mounted beside the secondary pane', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('workspace__session'), 'session pane must exist')
    assert.ok(explorer.includes('<WorkspaceSecondaryPane'), 'secondary pane must exist')
    assert.ok(explorer.includes('sessionNode'), 'conversation must mount as the primary pane')
    assert.ok(!explorer.includes('workbench__session'), 'conversation must not use a fixed side pane')
    const css = readRenderer('features/explorer/Explorer.css')
    const session = css.match(/\.session-frame\s*\{[^}]*\}/)
    assert.ok(session !== null && session[0].includes('border-radius: 12px'), 'session must be a calm rounded surface')
    const secondary = css.match(/\.workspace__secondary\s*\{[^}]*\}/)
    assert.ok(secondary !== null && secondary[0].includes('border-radius: 12px'), 'secondary must be a calm rounded surface')
  })

  it('attached context lives in the secondary pane, not the conversation flow', () => {
    const tab = readRenderer('features/sessions/ContextTab.tsx')
    assert.ok(tab.includes('Add note'), 'manual notes must stay reachable')
    assert.ok(tab.includes('No context attached'), 'empty-state guidance must stay reachable')
    assert.ok(tab.includes('Preview'), 'context previews must stay reachable')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__context-chips'), 'composer must summarize context as chips')
    assert.ok(panel.includes('onOpenContext'), 'chips must open the Context tab')
    assert.ok(!panel.includes('aria-label="Attached context"'), 'no large context drawer may remain in the conversation flow')
  })

  it('terminal stacks in the secondary region without a global drawer', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('aria-label="Hide terminal"'), 'stack state must be exposed')
    assert.ok(explorer.includes('<TerminalPanel'), 'open stack must host the terminal')
    assert.ok(explorer.includes('terminalOpen'), 'stack must be user-controlled')
    assert.ok(!explorer.includes('bottom-drawer'), 'the global bottom drawer must be retired')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes('workspace__terminal'), 'terminal must stack in the secondary region')
    const css = readRenderer('features/explorer/Explorer.css')
    const stack = css.match(/\.workspace__terminal\s*\{[^}]*\}/)
    assert.ok(stack !== null && stack[0].includes('min-height: 120px'), 'stack must stay bounded')
  })

  it('composer contains its modes, input, context state, and send', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__composer--'), 'composer must know the active mode')
    for (const feature of ['Composer mode', 'Message composer', 'Ask', 'Work', 'Propose change', 'Send']) {
      assert.ok(panel.includes(feature), `composer must contain ${feature}`)
    }
    const css = readRenderer('features/sessions/session.css')
    const composer = css.match(/\.session__composer\s*\{[^}]*\}/)
    assert.ok(composer !== null, 'composer dock CSS must exist')
    assert.ok(composer[0].includes('border-radius: 12px'), 'composer must be one rounded surface')
    assert.ok(composer[0].includes('border: 1px solid var(--stark-border)'), 'resting composer must be quiet neutral')
    assert.ok(css.includes('.session__composer--work:focus-within'), 'focused Work must read magenta')
    const send = css.match(/\.session__send\s*\{[^}]*\}/)
    assert.ok(send !== null && send[0].includes('background: var(--stark-lime)'), 'Send must use authoritative lime')
  })

  it('pending approval docks above the composer with exact actions', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__dock'), 'urgent actions must dock above the composer')
    for (const action of ['Deny', 'Approve']) {
      assert.ok(panel.includes(action), `approval must stay reachable: ${action}`)
    }
    assert.ok(panel.indexOf('session__dock') < panel.indexOf('session__composer--'), 'dock must precede the composer')
  })

  it('secondary session actions stay reachable without dominating', () => {
    const header = readRenderer('features/sessions/SessionHeaderBar.tsx')
    for (const action of ['New', 'Settings', 'Continue with Looplink', 'History']) {
      assert.ok(header.includes(action), `secondary action must stay reachable: ${action}`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('<SessionHeaderBar'), 'session must render the compact header')
    assert.ok(!panel.includes('session__looplink'), 'Looplink must not consume a permanent header row')
  })

  it('official lime + magenta brand is tokenized; mint is not brand', () => {
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.toLowerCase().includes('--stark-lime: #c8ff00'), 'primary lime token must be #c8ff00')
    assert.ok(tokens.toLowerCase().includes('--stark-magenta: #ff2ea6'), 'magenta token must be #ff2ea6')
    assert.ok(!tokens.includes('--stark-accent-2'), 'mint must not exist as a brand token')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('var(--stark-magenta)'), 'AI surfaces must show magenta')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes("tab: 'review'") || explorer.includes('Review'), 'review must exist as a secondary tab')
  })

  it('emblem asset slot exists with a faithful temporary stand-in', () => {
    const mark = readRenderer('components/StarkMark.tsx')
    assert.ok(mark.includes('StarkMark'), 'StarkMark component must exist')
    assert.ok(mark.includes('<img'), 'asset slot must render the official image when provided')
    assert.ok(mark.includes('stark-mark__fallback'), 'a temporary stand-in must cover the missing asset')
    assert.ok(mark.includes('official emblem asset'), 'slot must document the official-asset contract')
    const css = readRenderer('components/StarkMark.css')
    assert.ok(css.includes('var(--stark-lime)'), 'stand-in must use lime')
    assert.ok(css.includes('var(--stark-magenta)'), 'stand-in must use magenta, never mint')
  })

  it('icon set replaces glyph chrome with accessible SVG controls', () => {
    const icons = readRenderer('components/icons/StarkIcon.tsx')
    for (const name of ['menu', 'search', 'terminal', 'settings', 'close', 'plus', 'send']) {
      assert.ok(icons.includes(`'${name}'`), `icon set must include ${name}`)
    }
    assert.ok(icons.includes('<svg'), 'icons must render SVG')
    for (const file of ['layouts/AppChrome.tsx', 'features/explorer/ActivityRail.tsx']) {
      const source = readRenderer(file)
      for (const glyph of ['☰', '⌁', '▤', '⌕', '⇄', '⎇']) {
        assert.ok(!source.includes(glyph), `${file} must not use glyph chrome (${glyph})`)
      }
    }
  })

  it('filenames stay on one line with room for actions', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    const names = css.match(/\.explorer__name\s*\{[^}]*\}/g) ?? []
    assert.ok(names.length > 0, 'file row name CSS must exist')
    assert.ok(names.some((block) => block.includes('white-space: nowrap')), 'filenames must not wrap')
    assert.ok(names.some((block) => block.includes('text-overflow: ellipsis')), 'long filenames must ellipsize')
    assert.ok(!css.includes('overflow-wrap: anywhere'), 'paths must not wrap character-by-character')
    assert.ok(css.includes('.explorer__attach'), 'Attach action must be preserved')
  })

  it('workbench scrollbars are restrained and dark, never native white', () => {
    const global = readRenderer('styles/global.css')
    assert.ok(global.includes('::-webkit-scrollbar-thumb'), 'custom scrollbar thumbs must exist')
    assert.ok(global.includes('#2c352e'), 'scrollbar thumb must be muted dark neutral')
    assert.ok(!global.includes('#ffffff') && !global.includes('#fff'), 'no bright white scrollbar may appear')
    assert.ok(global.includes('scrollbar-width: thin'), 'scrollbars must be thin')
  })

  it('thin status strip carries version exactly once', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('workbench-status'), 'thin status strip must exist')
    const css = readRenderer('pages/HomePage.css')
    const bar = css.match(/\.workbench-status\s*\{[^}]*\}/)
    assert.ok(bar !== null, 'status CSS must exist')
    const height = bar[0].match(/min-height:\s*(\d+)px/)
    assert.ok(height !== null && Number(height[1]) >= 22 && Number(height[1]) <= 28, 'status must stay a quiet 22–28px strip')
    const status = readRenderer('features/system-status/SystemStatus.tsx')
    assert.ok(status.includes('appInfo.version'), 'status must show the version')
  })

  it('unified buttons cover every control with touch-safe metrics', () => {
    const global = readRenderer('styles/global.css')
    assert.ok(global.includes('.stark-btn--primary'), 'primary button variant must exist')
    assert.ok(global.includes('.stark-btn--danger'), 'danger button variant must exist')
    assert.ok(global.includes('min-height: 30px'), 'buttons must be touch-safe')
    assert.ok(global.includes('[aria-pressed="true"]'), 'selection must be visible without hover')
    for (const file of ['features/profile/ProfileSection.tsx', 'features/account/AccountSection.tsx']) {
      const source = readRenderer(file)
      const buttons = source.match(/<button[^>]*>/g) ?? []
      assert.ok(buttons.length > 0, `${file} must render buttons`)
      for (const button of buttons) {
        assert.ok(button.includes('className'), `${file} must not render browser-default buttons (${button})`)
      }
    }
  })

  it('typography reserves monospace for code, paths, and metadata', () => {
    const workspace = readRenderer('features/workspace/WorkspaceSection.css')
    const nameBlocks = workspace.match(/\.workspace__name\s*\{[^}]*\}/g) ?? []
    assert.ok(nameBlocks.some((block) => block.includes('var(--stark-font-sans)')), 'workspace name must read as UI text')
    const pathBlocks = workspace.match(/\.workspace__path\s*\{[^}]*\}/g) ?? []
    assert.ok(pathBlocks.some((block) => block.includes('var(--stark-font-mono)')), 'workspace path must stay monospace')
    const explorer = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorer.includes('var(--stark-font-mono)'), 'code and metadata must stay monospace')
  })

  it('workbench regions and every feature surface remain present', () => {
    const home = readRenderer('pages/HomePage.tsx')
    for (const region of ['<AppChrome', '<Explorer', 'stage-workarea', 'workbench-status']) {
      assert.ok(home.includes(region), `shell must keep ${region}`)
    }
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const feature of ['<WorkspaceToolsDrawer', '<SearchPanel', '<GitPanel', '<ChangesPanel', '<CodeEditor', '<TerminalPanel', 'Review change', '<ContextTab']) {
      assert.ok(explorer.includes(feature), `workbench must keep ${feature}`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const feature of [
      'Composer mode',
      'Message composer',
      'Ask',
      'Work',
      'Propose change',
      'Send',
      'Heart routing',
      'Workspace Agent Capabilities',
      'Open Preview',
      'Stop Runtime'
    ]) {
      const owner = feature === 'Heart routing' || feature === 'Workspace Agent Capabilities'
        ? readRenderer('features/sessions/StarkSettingsSurface.tsx')
        : panel
      assert.ok(owner.includes(feature), `shell must keep ${feature}`)
    }
    const header = readRenderer('features/sessions/SessionHeaderBar.tsx')
    assert.ok(header.includes('Continue with Looplink'), 'Looplink must remain reachable')
  })

  it('responsive shell never requires three squeezed columns', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sidebarOpen'), 'drawer must collapse on demand')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('sidebarOpen'), 'drawer visibility must gate the overlay')
    assert.ok(explorer.includes('canvasView'), 'narrow widths must switch instead of squeezing')
    assert.ok(explorer.includes('workspace__narrow-switch'), 'narrow widths must offer single-pane switching')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('@media'), 'narrow widths must adapt pane widths')
    assert.ok(css.includes('data-canvas-view="session"') || css.includes('[data-canvas-view'), 'single-pane switching must be wired')
  })

  it('shell adds no unsafe HTML and no new IPC surface', () => {
    for (const file of [
      'pages/HomePage.tsx',
      'layouts/AppChrome.tsx',
      'layouts/MainLayout.tsx',
      'layouts/WorkspaceToolsDrawer.tsx',
      'features/explorer/Explorer.tsx',
      'features/explorer/ActivityRail.tsx',
      'features/sessions/SessionPanel.tsx',
      'features/sessions/SessionHeaderBar.tsx',
      'features/sessions/StarkSettingsSurface.tsx',
      'features/sessions/ContextTab.tsx',
      'features/profile/ProfileSection.tsx',
      'features/account/AccountSection.tsx',
      'components/StarkMark.tsx',
      'components/icons/StarkIcon.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('dangerouslySetInnerHTML'), `${file} must not render raw HTML`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
  })

  it('schema remains v18 with no migration 019', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('018-cloud-account.ts'), 'migration 018 must exist (schema v18)')
    assert.ok(!files.some((file) => file.startsWith('019')), 'no migration 019 may appear for a visual pass')
    const index = readSource('src', 'main', 'database', 'migrations', 'index.ts')
    assert.ok(!index.includes('019'), 'migration registry must stay at v18')
  })
})
