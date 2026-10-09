import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 frontend rearchitecture regression: one global bar above
 * rail + contextual sidebar + primary canvas (Session | Editor) with
 * a docked terminal drawer and a thin status strip. Official brand is
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
    const shell = readRenderer('layouts/MainLayout.tsx')
    assert.ok(!shell.includes('shell__header'), 'shell must not stack a second toolbar')
    assert.ok(!shell.includes('FOUNDATION'), 'shell must not render foundation copy')
  })

  it('activity rail selects one contextual sidebar', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const activity of ['explorer', 'search', 'changes', 'git']) {
      assert.ok(rail.includes(activity), `rail must offer the ${activity} activity`)
    }
    assert.ok(rail.includes('aria-selected'), 'rail must expose selection')
    assert.ok(rail.includes('title='), 'rail must tooltip its icon-first controls')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<ActivityRail'), 'shell must render the rail')
    assert.ok(explorer.includes('activity={activity}'), 'rail must drive the controlled activity')
    assert.ok(explorer.includes('onSelect={onActivityChange}'), 'rail selection must reach the sidebar')
    const css = readRenderer('features/explorer/Explorer.css')
    const column = css.match(/\.activity-rail\s*\{[^}]*\}/)
    assert.ok(column !== null, 'rail column CSS must exist')
    const width = column[0].match(/width:\s*(\d+)px/)
    assert.ok(width !== null && Number(width[1]) >= 44 && Number(width[1]) <= 52, 'rail must stay a compact 44–52px')
    const active = css.match(/\.explorer__tab--active\s*\{[^}]*\}/)
    assert.ok(active !== null, 'selected rail state must exist')
    assert.ok(!active[0].includes('background: var(--stark-lime);'), 'selection must be an indicator, not a neon block')
  })

  it('session conversation receives the primary canvas width', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('primary-canvas'), 'canvas surface must exist')
    assert.ok(explorer.includes('canvas-tabs'), 'canvas must expose Session and Editor views')
    assert.ok(explorer.includes('sessionNode'), 'conversation must mount as a primary view')
    assert.ok(!explorer.includes('workbench__session'), 'conversation must not use a fixed side pane')
    const css = readRenderer('features/explorer/Explorer.css')
    const canvas = css.match(/\.primary-canvas\s*\{[^}]*\}/)
    assert.ok(canvas !== null && canvas[0].includes('border-radius: 14px'), 'canvas must be a calm rounded surface')
    const view = css.match(/\.canvas-view\s*\{[^}]*\}/)
    assert.ok(view !== null && view[0].includes('flex: 1'), 'views must fill the canvas')
    assert.ok(css.includes('.canvas-view[hidden]'), 'inactive views must hide without unmounting')
  })

  it('context drawer collapses without losing functionality', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('contextOpen'), 'attached context must collapse')
    assert.ok(panel.includes('aria-expanded={contextOpen}'), 'collapse state must be exposed')
    assert.ok(panel.includes('Attached context'), 'context must keep its identity')
    assert.ok(panel.includes('Add note'), 'manual notes must stay reachable')
    assert.ok(panel.includes('No context attached'), 'empty-state guidance must stay reachable')
  })

  it('terminal drawer collapses to a handle without reserving height', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('bottom-drawer__handle'), 'closed drawer must be a minimal handle')
    assert.ok(explorer.includes('aria-expanded'), 'drawer state must be exposed')
    assert.ok(explorer.includes('<TerminalPanel'), 'open drawer must host the terminal')
    assert.ok(explorer.includes('terminalOpen'), 'drawer must be user-controlled')
    const css = readRenderer('features/explorer/Explorer.css')
    const handle = css.match(/\.bottom-drawer__handle\s*\{[^}]*\}/)
    assert.ok(handle !== null && handle[0].includes('min-height: 32px'), 'handle must stay a slim strip')
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

  it('secondary session actions stay reachable without dominating', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const action of ['New', 'Settings', 'Continue with Looplink', 'History', 'Recent sessions']) {
      assert.ok(panel.includes(action), `secondary action must stay reachable: ${action}`)
    }
    assert.ok(panel.includes('session__menu'), 'secondary actions must live in compact chrome')
    assert.ok(panel.includes('session__looplink'), 'Looplink must stay a recognizable text action')
  })

  it('official lime + magenta brand is tokenized; mint is not brand', () => {
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.toLowerCase().includes('--stark-lime: #c8ff00'), 'primary lime token must be #c8ff00')
    assert.ok(tokens.toLowerCase().includes('--stark-magenta: #ff2ea6'), 'magenta token must be #ff2ea6')
    assert.ok(!tokens.includes('--stark-accent-2'), 'mint must not exist as a brand token')
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('var(--stark-magenta)'), 'AI surfaces must show magenta')
    const tabs = readRenderer('features/explorer/Explorer.css')
    assert.ok(tabs.includes('.canvas-tab--session.canvas-tab--active'), 'active AI tab must carry the AI accent')
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
    assert.ok(height !== null && Number(height[1]) >= 28 && Number(height[1]) <= 32, 'status must stay a 28–32px strip')
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
    for (const feature of ['<ActivityRail', '<SearchPanel', '<GitPanel', '<ChangesPanel', '<CodeEditor', '<TerminalPanel', 'Review change', '<WorkspaceSection']) {
      assert.ok(explorer.includes(feature), `workbench must keep ${feature}`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const feature of [
      'Settings',
      'Composer mode',
      'Message composer',
      'Ask',
      'Work',
      'Propose change',
      'Send',
      'Continue with Looplink',
      'Heart routing',
      'Workspace Agent Capabilities',
      'Open Preview',
      'Stop Runtime'
    ]) {
      assert.ok(panel.includes(feature), `session panel must keep ${feature}`)
    }
  })

  it('responsive shell never requires three squeezed columns', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('sidebarOpen'), 'sidebar must collapse on demand')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('sidebarOpen'), 'sidebar visibility must gate the pane')
    assert.ok(explorer.includes('canvasView'), 'canvas must switch instead of squeezing')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('minmax(0, 1fr)'), 'canvas must flex into available width')
    assert.ok(css.includes('@media'), 'narrow widths must adapt pane widths')
  })

  it('shell adds no unsafe HTML and no new IPC surface', () => {
    for (const file of [
      'pages/HomePage.tsx',
      'layouts/AppChrome.tsx',
      'layouts/MainLayout.tsx',
      'features/explorer/Explorer.tsx',
      'features/explorer/ActivityRail.tsx',
      'features/sessions/SessionPanel.tsx',
      'features/profile/ProfileSection.tsx',
      'features/account/AccountSection.tsx',
      'components/StarkMark.tsx'
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
