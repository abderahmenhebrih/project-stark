import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 frontend polish regression (pass 2): the desktop shell keeps
 * every behavior while presenting an IDE hierarchy with the two
 * official STARK brand colors — electric neon lime (primary) and neon
 * magenta (AI/agent accent). The repo green is a semantic success
 * color only and must never stand in as brand identity.
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

describe('stage 31 frontend polish', () => {
  it('session header toolbar wraps instead of clipping controls', () => {
    const css = readRenderer('features/sessions/session.css')
    const header = css.match(/\.session__header\s*\{[^}]*\}/)
    assert.ok(header !== null, 'session header CSS must exist')
    assert.ok(header[0].includes('flex-wrap: wrap'), 'header must wrap instead of clipping')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const action of ['New', 'Settings', 'Hide session panel', 'Continue with Looplink']) {
      assert.ok(panel.includes(action), `header must keep the ${action} action`)
    }
    assert.ok(panel.includes('session__looplink'), 'Looplink must stay a recognizable text action')
    assert.ok(css.includes('.session__composer-row'), 'composer rows must exist')
    assert.ok(css.includes('.session__settings-row'), 'settings rows must exist')
    for (const selector of ['.session__composer-row', '.session__settings-row', '.session__history']) {
      const escaped = selector.replace(/-/g, '\\-')
      const blocks = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 'g')) ?? []
      assert.ok(blocks.length > 0, `${selector} CSS must exist`)
      assert.ok(blocks.some((block) => block.includes('flex-wrap: wrap')), `${selector} must wrap on narrow widths`)
    }
    const terminal = readRenderer('features/terminal/TerminalPanel.css')
    assert.ok(terminal.includes('.terminal__bar'), 'terminal bar CSS must exist')
    assert.ok(terminal.includes('flex-wrap: wrap'), 'terminal bar must wrap on narrow widths')
  })

  it('official lime + magenta brand is tokenized; mint is not brand', () => {
    const tokens = readRenderer('styles/tokens.css')
    assert.ok(tokens.toLowerCase().includes('--stark-lime: #c8ff00'), 'primary lime token must be #c8ff00')
    assert.ok(tokens.toLowerCase().includes('--stark-magenta: #ff2ea6'), 'magenta token must be #ff2ea6')
    assert.ok(!tokens.includes('--stark-accent-2'), 'mint must not exist as a brand token')
    assert.ok(tokens.includes('--stark-success: #3ddc84'), 'green stays a semantic success color only')
    const magentaCandidates = [
      'features/sessions/session.css',
      'features/editor/editor.css',
      'components/StarkMark.css',
      'styles/global.css'
    ]
    let magentaUses = 0
    for (const relative of magentaCandidates) {
      if (readRenderer(relative).includes('var(--stark-magenta')) {
        magentaUses += 1
      }
    }
    assert.ok(magentaUses >= 2, 'magenta must mark AI/assistant/emblem surfaces')
    const limeCandidates = [
      'features/sessions/session.css',
      'pages/HomePage.css',
      'features/explorer/Explorer.css',
      'features/terminal/TerminalPanel.css',
      'styles/global.css'
    ]
    let limeUses = 0
    for (const relative of limeCandidates) {
      const css = readRenderer(relative)
      if (css.includes('var(--stark-lime') || css.includes('var(--stark-accent')) {
        limeUses += 1
      }
    }
    assert.ok(limeUses >= 4, 'lime must drive primary/selected/focus states')
  })

  it('emblem asset slot exists with a faithful temporary stand-in', () => {
    const mark = readRenderer('components/StarkMark.tsx')
    assert.ok(mark.includes('StarkMark'), 'StarkMark component must exist')
    assert.ok(mark.includes('src'), 'emblem must accept an official asset source')
    assert.ok(mark.includes('<img'), 'asset slot must render the official image when provided')
    assert.ok(mark.includes('stark-mark__fallback'), 'a temporary stand-in must cover the missing asset')
    const css = readRenderer('components/StarkMark.css')
    assert.ok(css.includes('var(--stark-lime)'), 'stand-in must use lime')
    assert.ok(css.includes('var(--stark-magenta)'), 'stand-in must use magenta, never mint')
    assert.ok(!css.toLowerCase().includes('#3ddc84'), 'stand-in must not use mint green')
    for (const user of ['layouts/MainLayout.tsx', 'pages/HomePage.tsx', 'features/explorer/Explorer.tsx']) {
      assert.ok(readRenderer(user).includes('<StarkMark'), `${user} must render the emblem slot`)
    }
  })

  it('top bar is one compact row: emblem, breadcrumb, global actions', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('workbench-top__brand'), 'top bar must carry the emblem + wordmark')
    assert.ok(home.includes('workbench-top__crumb'), 'top bar must carry the workspace breadcrumb')
    assert.ok(home.includes('workbench-top__name'), 'breadcrumb must show the workspace name')
    assert.ok(home.includes('workbench-top__path'), 'path must render as muted secondary metadata')
    assert.ok(!home.includes('workbench-greeting'), 'awkward multi-row greeting must be retired')
    const css = readRenderer('pages/HomePage.css')
    const top = css.match(/\.workbench-top\s*\{[^}]*\}/)
    assert.ok(top !== null && top[0].includes('min-height: 40px'), 'top bar must stay compact')
  })

  it('activity rail shows icon plus full labels that can never truncate', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('aria-orientation="vertical"'), 'navigation must be a vertical rail')
    for (const label of ['Explorer', 'Search', 'Changes', 'Git']) {
      assert.ok(explorer.includes(label), `rail must keep the full ${label} label`)
    }
    assert.ok(explorer.includes('explorer__tab-icon'), 'rail items must carry icons')
    assert.ok(explorer.includes('explorer__tab-label'), 'rail items must carry full labels')
    const css = readRenderer('features/explorer/Explorer.css')
    const rail = css.match(/\.workbench__tabs\s*\{[^}]*\}/)
    assert.ok(rail !== null, 'rail CSS must exist')
    assert.ok(rail[0].includes('flex-direction: column'), 'rail must be vertical')
    const railWidth = rail[0].match(/width:\s*(\d+)px/)
    assert.ok(railWidth !== null, 'rail must declare a fixed width')
    assert.ok(Number(railWidth[1]) >= 52 && Number(railWidth[1]) <= 58, 'rail must stay a slim 52–58px')
    const label = css.match(/\.explorer__tab-label\s*\{[^}]*\}/)
    assert.ok(label !== null, 'rail label CSS must exist')
    assert.ok(!label[0].includes('text-overflow: ellipsis'), 'primary navigation must never truncate')
    const active = css.match(/\.explorer__tab--active\s*\{[^}]*\}/)
    assert.ok(active !== null, 'selected rail state must exist')
    assert.ok(!active[0].includes('background: var(--stark-lime);'), 'selected rail must not be a solid neon rectangle')
  })

  it('filenames stay on one line with room for the Attach action', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    const names = css.match(/\.explorer__name\s*\{[^}]*\}/g) ?? []
    assert.ok(names.length > 0, 'file row name CSS must exist')
    assert.ok(names.some((block) => block.includes('white-space: nowrap')), 'filenames must not wrap')
    assert.ok(names.some((block) => block.includes('text-overflow: ellipsis')), 'long filenames must ellipsize')
    assert.ok(!css.includes('overflow-wrap: anywhere'), 'paths must not wrap character-by-character')
    assert.ok(css.includes('.explorer__attach'), 'Attach action must be preserved')
    const sidebar = css.match(/\.workbench__sidebar\s*\{[^}]*\}/)
    assert.ok(sidebar !== null, 'sidebar CSS must exist')
    const sidebarWidth = sidebar[0].match(/width:\s*(\d+)px/)
    assert.ok(sidebarWidth !== null && Number(sidebarWidth[1]) >= 300, 'Explorer must reserve 260–300px content plus the rail')
  })

  it('workbench scrollbars are restrained and dark, never native white', () => {
    const global = readRenderer('styles/global.css')
    assert.ok(global.includes('::-webkit-scrollbar-thumb'), 'custom scrollbar thumbs must exist')
    assert.ok(global.includes('#2c352e'), 'scrollbar thumb must be muted dark neutral')
    assert.ok(!global.includes('#ffffff') && !global.includes('#fff'), 'no bright white scrollbar may appear')
    assert.ok(global.includes('scrollbar-width: thin'), 'scrollbars must be thin')
  })

  it('composer is one rounded surface with per-mode selection states', () => {
    const css = readRenderer('features/sessions/session.css')
    const composer = css.match(/\.session__composer\s*\{[^}]*\}/)
    assert.ok(composer !== null, 'composer dock CSS must exist')
    assert.ok(composer[0].includes('border-radius: 12px'), 'composer must be one 12px rounded surface')
    assert.ok(composer[0].includes('border: 1px solid var(--stark-border)'), 'resting composer must be quiet neutral, never permanent neon')
    assert.ok(css.includes('.session__composer:focus-within'), 'composer must highlight as one surface on focus')
    assert.ok(css.includes('.session__composer--work:focus-within'), 'focused Work must read magenta')
    assert.ok(css.includes('.session__composer--propose:focus-within'), 'focused Propose must stay restrained')
    const input = css.match(/\.session__input\s*\{[^}]*\}/)
    assert.ok(input !== null && input[0].includes('background: transparent'), 'input must sit inside the surface, not its own box')
    assert.ok(css.includes('.session__mode--work[aria-pressed="true"]'), 'Work selection must read magenta')
    assert.ok(css.includes('var(--stark-magenta)'), 'agent mode must use the AI accent')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__send'), 'Send must be a distinct solid primary action')
    const send = css.match(/\.session__send\s*\{[^}]*\}/)
    assert.ok(send !== null, 'Send CSS must exist')
    assert.ok(send[0].includes('background: var(--stark-lime)'), 'Send must use authoritative STARK lime, never olive')
    assert.ok(send[0].includes('min-height: 34px'), 'Send must be a substantial touch target')
    const sendDisabled = css.match(/\.session__send:disabled\s*\{[^}]*\}/)
    assert.ok(sendDisabled !== null, 'Send disabled state must stay clearly disabled')
    const panelModes = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panelModes.includes('session__mode--ask'), 'Ask mode must carry a mode class')
    assert.ok(panelModes.includes('session__mode--propose'), 'Propose mode must carry a mode class')
    assert.ok(panel.includes('session__composer--'), 'composer must carry the active mode for focus accents')
    assert.ok(css.includes('.session__composer .session__mode'), 'mode selector must be styled inside the dock')
  })

  it('conversation gives priority to messages with AI identity restraint', () => {
    const css = readRenderer('features/sessions/session.css')
    assert.ok(css.includes('.session__message--assistant'), 'assistant messages must be distinguishable')
    assert.ok(css.includes('.session__message--assistant .session__role'), 'assistant marker must use the role label')
    const assistant = css.match(/\.session__message--assistant\s*\{[^}]*\}/)
    assert.ok(assistant !== null && assistant[0].includes('var(--stark-magenta)'), 'assistant must carry the magenta identity edge')
    const message = css.match(/\.session__message\s*\{[^}]*\}/)
    assert.ok(message !== null && !message[0].includes('1px solid var(--stark-border)'), 'messages must layer surfaces, not outline boxes')
  })

  it('unified button system covers every control with touch-safe metrics', () => {
    const global = readRenderer('styles/global.css')
    assert.ok(global.includes('.stark-btn'), 'shared button classes must exist')
    assert.ok(global.includes('.stark-btn--primary'), 'primary button variant must exist')
    assert.ok(global.includes('.stark-btn--secondary'), 'secondary button variant must exist')
    assert.ok(global.includes('.stark-btn--danger'), 'danger button variant must exist')
    assert.ok(global.includes('min-height: 30px'), 'buttons must be touch-safe (30px minimum)')
    assert.ok(global.includes(':disabled'), 'disabled state must be styled')
    assert.ok(global.includes('[aria-pressed="true"]'), 'selected toggle state must be visible without hover')
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
    assert.ok(nameBlocks.length > 0, 'workspace name CSS must exist')
    assert.ok(nameBlocks.some((block) => block.includes('var(--stark-font-sans)')), 'workspace name must read as UI text, not terminal text')
    const pathBlocks = workspace.match(/\.workspace__path\s*\{[^}]*\}/g) ?? []
    assert.ok(pathBlocks.length > 0, 'workspace path CSS must exist')
    assert.ok(pathBlocks.some((block) => block.includes('var(--stark-font-mono)')), 'workspace path must stay monospace')
    const terminal = readRenderer('features/terminal/TerminalPanel.css')
    assert.ok(terminal.includes('var(--stark-font-mono)'), 'terminal chrome must stay monospace')
    const home = readRenderer('pages/HomePage.css')
    assert.ok(home.includes('.workbench-top__name'), 'breadcrumb name CSS must exist')
    const crumb = home.match(/\.workbench-top__name\s*\{[^}]*\}/)
    assert.ok(crumb !== null && crumb[0].includes('var(--stark-font-sans)'), 'breadcrumb name must be UI sans')
  })

  it('profile editing is compact inside the status bar, never a full-width strip', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes('workbench-status'), 'workbench status bar must exist')
    assert.ok(home.includes('<ProfileSection'), 'local profile editing must be preserved')
    assert.ok(home.includes('<SystemStatus'), 'system status must be preserved')
    const css = readRenderer('pages/HomePage.css')
    const compact = css.match(/\.workbench-status \.profile-section\s*\{[^}]*\}/)
    assert.ok(compact !== null, 'status-bar profile must have compact rules')
    assert.ok(compact[0].includes('inline-flex'), 'status-bar profile must be an inline row')
  })

  it('one status bar carries version; no duplicate footer exists', () => {
    const shell = readRenderer('layouts/MainLayout.tsx')
    assert.ok(!shell.includes('shell__footer'), 'redundant footer must be removed')
    assert.ok(!shell.includes('shell__footer-version'), 'version must live in exactly one place')
    assert.ok(!shell.includes('FOUNDATION'), 'unfinished foundation chrome must be removed')
    const shellCss = readRenderer('layouts/MainLayout.css')
    assert.ok(!shellCss.includes('.shell__footer'), 'footer styles must be removed')
    const status = readRenderer('features/system-status/SystemStatus.tsx')
    assert.ok(status.includes('appInfo.version'), 'status bar must show the version')
    assert.ok(status.includes('appInfo.platform'), 'status bar must show the platform')
    const homeCss = readRenderer('pages/HomePage.css')
    const bar = homeCss.match(/\.workbench-status\s*\{[^}]*\}/)
    assert.ok(bar !== null, 'status bar CSS must exist')
    assert.ok(bar[0].includes('min-height: 30px'), 'status bar must stay a compact 28–32px strip')
  })

  it('editor empty state carries the STARK emblem with the same guidance', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('Select a file to open'), 'empty pane must keep its guidance copy')
    assert.ok(explorer.includes('<StarkMark size="hero"'), 'empty state must use the emblem slot')
    assert.ok(!explorer.includes('editor-empty__mark'), 'generic square must be retired')
  })

  it('workbench regions and every feature surface remain present', () => {
    const home = readRenderer('pages/HomePage.tsx')
    for (const region of ['workbench-top', 'workbench-main', 'workbench-status', '<Explorer', '<SessionPanel']) {
      assert.ok(home.includes(region), `workbench must keep ${region}`)
    }
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const feature of ['<SearchPanel', '<GitPanel', '<ChangesPanel', '<CodeEditor', '<TerminalPanel', 'Review change']) {
      assert.ok(explorer.includes(feature), `center/left must keep ${feature}`)
    }
    assert.ok(explorer.includes('role="tablist"'), 'sidebar navigation must stay a tab system')
    for (const tab of ['Explorer', 'Search', 'Changes', 'Git']) {
      assert.ok(explorer.includes(tab), `sidebar tabs must keep ${tab}`)
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

  it('polish adds no unsafe HTML and no new IPC surface', () => {
    for (const file of [
      'pages/HomePage.tsx',
      'features/explorer/Explorer.tsx',
      'features/sessions/SessionPanel.tsx',
      'features/profile/ProfileSection.tsx',
      'features/account/AccountSection.tsx',
      'layouts/MainLayout.tsx',
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
    assert.ok(!files.some((file) => file.startsWith('019')), 'no migration 019 may appear for a polish pass')
    const index = readSource('src', 'main', 'database', 'migrations', 'index.ts')
    assert.ok(!index.includes('019'), 'migration registry must stay at v18')
  })
})
