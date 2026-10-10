import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 frontend shell regression: one global bar above a primary
 * session pane + contextual secondary pane (Review | Context | file
 * with a stacked terminal), an overlay workspace-tools drawer with no
 * bottom footer, and a dedicated settings surface. Official brand is
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
    assert.ok(chrome.includes('Search workspace'), 'workspace search must stay one click away')
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
    assert.ok(drawer[0].includes('width: 392px'), 'drawer must be approximately 380–410px on desktop')
    const railCss = css.match(/\.workspace-tools-drawer__body \.activity-rail\s*\{[^}]*\}/)
    assert.ok(railCss !== null && railCss[0].includes('flex: 0 0 86px'), 'rail must be a fixed 82–90px')
    const content = css.match(/\.workspace-tools-drawer__content\s*\{[^}]*\}/)
    assert.ok(content !== null && content[0].includes('flex: 1 1 0'), 'content pane must be flexible minmax(0,1fr)')
    const close = css.match(/\.workspace-tools-drawer__close\s*\{[^}]*\}/)
    assert.ok(close !== null && close[0].includes('position: absolute'), 'close must sit top-right, off the header row')
    assert.ok(readRenderer('features/workspace/DrawerWorkspaceMenu.tsx').includes('Open another folder'), 'folder switch must stay reachable through the drawer overflow')
    const active = css.match(/\.explorer__tab--active\s*\{[^}]*\}/)
    assert.ok(active !== null, 'selected activity state must exist')
    assert.ok(active[0].includes('background: var(--stark-elevated)'), 'selection must be a dark surface, not a lime block')
    assert.ok(!active[0].includes('background: var(--stark-lime);'), 'selection must be an indicator, not a neon block')
  })

  it('drawer title row stays compact with an ellipsis-safe title', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    const head = css.match(/\.workspace-tools-drawer__head\s*\{[^}]*\}/)
    assert.ok(head !== null && head[0].includes('min-height: 38px'), 'title row must stand 36–40px')
    const title = css.match(/\.workspace-tools-drawer__title\s*\{[^}]*\}/)
    assert.ok(title !== null, 'activity title must be styled')
    assert.ok(title[0].includes('white-space: nowrap'), 'title must not wrap')
    assert.ok(title[0].includes('text-overflow: ellipsis'), 'title must ellipsize')
    const root = css.match(/\.explorer__root-name\s*\{[^}]*\}/)
    assert.ok(root !== null, 'root row name must be styled')
    assert.ok(root[0].includes('white-space: nowrap'), 'root name must not wrap')
    assert.ok(root[0].includes('text-overflow: ellipsis'), 'long project names must ellipsize')
  })

  it('workspace tools drawer reads as a substantial project navigator', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    const drawer = css.match(/\.workspace-tools-drawer\s*\{[^}]*\}/)
    assert.ok(drawer !== null, 'drawer CSS must exist')
    const drawerWidth = drawer[0].match(/width:\s*(\d+)px/)
    assert.ok(drawerWidth !== null, 'drawer must declare a fixed desktop width')
    const drawerWidthPx = Number(drawerWidth[1])
    assert.ok(drawerWidthPx >= 380 && drawerWidthPx <= 410, `drawer width must sit in 380–410px, got ${drawerWidthPx}px`)
    assert.ok(drawer[0].includes('border-radius: 12px'), 'drawer must keep the 12px outer radius')
    const railCss = css.match(/\.workspace-tools-drawer__body \.activity-rail\s*\{[^}]*\}/)
    assert.ok(railCss !== null, 'in-drawer rail CSS must exist')
    const railWidth = railCss[0].match(/flex:\s*0\s+0\s+(\d+)px/)
    assert.ok(railWidth !== null, 'rail must declare a fixed width')
    const railWidthPx = Number(railWidth[1])
    assert.ok(railWidthPx >= 82 && railWidthPx <= 90, `rail width must sit in 82–90px, got ${railWidthPx}px`)
    const tab = css.match(/\.explorer__tab\s*\{[^}]*\}/)
    assert.ok(tab !== null, 'rail item CSS must exist')
    const tabHeight = tab[0].match(/min-height:\s*(\d+)px/)
    assert.ok(tabHeight !== null, 'rail items must declare a fixed height')
    const tabHeightPx = Number(tabHeight[1])
    assert.ok(tabHeightPx >= 68 && tabHeightPx <= 76, `rail items must sit in 68–76px, got ${tabHeightPx}px`)
    const label = css.match(/\.explorer__tab-label\s*\{[^}]*\}/)
    assert.ok(label !== null, 'rail labels must be styled visible')
    const labelSize = label[0].match(/font-size:\s*([\d.]+)px/)
    assert.ok(labelSize !== null, 'rail labels must declare a size')
    const labelSizePx = Number(labelSize[1])
    assert.ok(labelSizePx >= 11 && labelSizePx <= 12, `rail labels must sit in 11–12px, got ${labelSizePx}px`)
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const activity of ['Explorer', 'Search', 'Changes', 'Git', 'Extensions']) {
      assert.ok(rail.includes(activity), `rail must keep the visible ${activity} label`)
    }
  })

  it('drawer exposes workspace switching through the overflow, not a project card', () => {
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(!drawer.includes('<WorkspaceSection'), 'large project card must be gone from the drawer')
    assert.ok(drawer.includes('<DrawerWorkspaceMenu'), 'drawer must host the workspace actions overflow')
    assert.ok(drawer.includes('workspace-tools-drawer__title'), 'drawer must name the active activity')
    const menu = readRenderer('features/workspace/DrawerWorkspaceMenu.tsx')
    assert.ok(menu.includes('Open another folder'), 'folder action must keep its full readable label')
    assert.ok(menu.includes('handleChooseWorkspace') || menu.includes('chooseWorkspaceWithGuards'), 'folder action must reuse the guarded picker flow')
    assert.ok(menu.includes('Recent workspaces'), 'recent heading must be present in the overflow')
    assert.ok(menu.includes('aria-label="Workspace actions"'), 'overflow must be labelled for assistive tech')
    const section = readRenderer('features/workspace/WorkspaceSection.tsx')
    assert.ok(section.includes('Open project folder'), 'welcome surface must keep its open action')
    assert.ok(section.includes('handleChooseWorkspace'), 'welcome action must reuse the native picker handler')
  })

  it('explorer rows show chevrons, type icons, names, and compact attach', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('explorer__folder-icon'), 'folder rows must include a folder icon')
    assert.ok(explorer.includes('explorer__file-icon'), 'file rows must include a type icon')
    assert.ok(explorer.includes('getFileIconKind'), 'file icons must resolve from the filename')
    assert.ok(explorer.includes('title="Attach to context"'), 'attach action must carry the context tooltip')
    assert.ok(explorer.includes('onClick={() => onAttachFile(entry.relativePath)}'), 'attach must reuse the existing handler')
    assert.ok(explorer.includes('onAttachFile={handleAttachTreeFile}'), 'tree attach must stay wired to context drafts')
    assert.ok(explorer.includes('aria-current={state.selectedPath'), 'open file must be exposed to assistive tech')
    assert.ok(!explorer.includes('magenta'), 'explorer tree must stay lime/neutral, never magenta')
    const assetDir = join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'file-icons')
    const requiredAssets = [
      'folder.svg',
      'folder-open.svg',
      'file.svg',
      'markdown.svg',
      'javascript.svg',
      'typescript.svg',
      'json.svg',
      'git.svg',
      'config.svg',
      'package.svg'
    ]
    for (const asset of requiredAssets) {
      const assetPath = join(assetDir, asset)
      assert.ok(existsSync(assetPath), `local icon asset must exist: ${asset}`)
      const content = readFileSync(assetPath, 'utf8')
      assert.ok(content.includes('<svg'), `${asset} must be an SVG document`)
      assert.ok(!content.includes('<script'), `${asset} must not contain scripts`)
    }
    const assetMap = readRenderer('features/explorer/fileIconAssets.ts')
    assert.ok(!assetMap.includes('http://') && !assetMap.includes('https://'), 'icon assets must load locally, never remote')
    assert.ok(!assetMap.includes('vscode-icons') || assetMap.includes('THIRD_PARTY'), 'asset module must not fetch from upstream at runtime')
    for (const asset of requiredAssets) {
      assert.ok(assetMap.includes(asset), `asset map must reference local ${asset}`)
    }
    assert.ok(assetMap.includes('FOLDER_ICON_URL') && assetMap.includes('FOLDER_OPEN_ICON_URL'), 'folder open/closed URLs must both be exported')
    assert.ok(explorer.includes('FOLDER_OPEN_ICON_URL'), 'expanded directories must use the open folder icon')
    assert.ok(explorer.includes('FILE_ICON_URLS[getFileIconKind'), 'file icons must resolve through the pure mapping')
    assert.ok(readSource('THIRD_PARTY_NOTICES.md').includes('vscode-icons'), 'icon provenance must be recorded')
    const css = readRenderer('features/explorer/Explorer.css')
    const row = css.match(/\.explorer__row\s*\{[^}]*\}/)
    assert.ok(row !== null, 'row CSS must exist')
    const rowHeight = row[0].match(/min-height:\s*(\d+)px/)
    assert.ok(rowHeight !== null, 'rows must declare a height')
    const rowHeightPx = Number(rowHeight[1])
    assert.ok(rowHeightPx >= 30 && rowHeightPx <= 32, `rows must sit in 30–32px, got ${rowHeightPx}px`)
    assert.ok(css.includes('.explorer__file-row--selected'), 'open file must have a selected style')
    const selected = css.match(/\.explorer__file-row--selected\s*\{[^}]*\}/)
    assert.ok(selected !== null && selected[0].includes('var(--stark-lime)'), 'selected file must use a lime indicator, not a fill')
    assert.ok(!selected[0].includes('background: var(--stark-lime)'), 'selected file must not be a bright fill')
    const attach = css.match(/\.explorer__attach\s*\{[^}]*\}/)
    assert.ok(attach !== null, 'attach action CSS must exist')
    assert.ok(!attach[0].includes('opacity: 0'), 'attach must never be hover-only')
    assert.ok(!attach[0].includes('display: none'), 'attach must stay reachable on touch')
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

  it('top bar is a session tab strip without a permanent search field', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(!chrome.includes('app-chrome__search'), 'large permanent search field must be gone')
    assert.ok(!chrome.includes('Search workspace…'), 'no permanent search box copy may remain')
    assert.ok(chrome.includes('app-chrome__tab'), 'active session must render as a desktop tab')
    assert.ok(chrome.includes('sessionTitle'), 'tab must show the selected session title')
    assert.ok(chrome.includes('app-chrome__tab-dot'), 'tab must carry the magenta AI identity cue')
    // Presentation-only close: a compact X at the far right of the
    // tab closes the presentation without deleting history. It must
    // carry an accessible label, stop propagation, and never read as
    // Delete.
    assert.ok(chrome.includes('app-chrome__tab-close'), 'tab must render a compact close affordance')
    assert.ok(chrome.includes('aria-label="Close session"'), 'close must be keyboard-accessible with a label')
    assert.ok(chrome.includes('stopPropagation'), 'close must not trigger tab selection underneath')
    assert.ok(chrome.includes('onCloseSession'), 'close must invoke the existing presentation-close action')
    assert.ok(!chrome.includes('Delete session') && !chrome.includes('aria-label="Delete'), 'close must never read as delete')
    const tabs = chrome.match(/role="tab"/g) ?? []
    assert.equal(tabs.length, 1, 'only the active session renders as a tab; no fake multi-tab system')
    assert.ok(chrome.includes('app-chrome__newtab'), 'New Session + must sit beside the tab')
    assert.ok(chrome.includes('onNewSession'), '+ must invoke the existing new-session action')
    assert.ok(chrome.includes('app-chrome__history-item'), 'history must live in the tab overflow')
    assert.ok(chrome.includes('onSelectSession'), 'history must switch via the existing select action')
    assert.ok(chrome.includes('Continue with Looplink'), 'Looplink must stay in the session overflow')
    assert.ok(chrome.includes('name="search"'), 'search must stay one icon click away')
    assert.ok(chrome.includes('workspaceName'), 'workspace name must stay visible')
    const css = readRenderer('layouts/AppChrome.css')
    assert.ok(!css.includes('.app-chrome__search'), 'search field CSS must be retired')
    const tab = css.match(/\.app-chrome__tab\s*\{[^}]*\}/)
    assert.ok(tab !== null, 'tab CSS must exist')
    assert.ok(tab[0].includes('border-radius: 10px'), 'tab must read as a desktop pill')
    assert.ok(tab[0].includes('min-height: 44px'), 'tab must scale with the 60px chrome (44–48px)')
    assert.ok(tab[0].includes('min-width: 180px') || css.includes('min-width: 180px'), 'tab must not collapse')
    assert.ok(css.includes('max-width: 420px'), 'long titles must not consume the toolbar')
    assert.ok(tab[0].includes('background: var(--stark-elevated)'), 'tab resting surface must stay neutral')
    const dot = css.match(/\.app-chrome__tab-dot\s*\{[^}]*\}/)
    assert.ok(dot !== null && dot[0].includes('background: var(--stark-magenta)'), 'tab identity must read magenta')
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(home.includes("setActivity('search')"), 'search must remain reachable via the workspace drawer')
  })

  it('giant inner New button and duplicated session header are gone', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('<SessionHeaderBar'), 'redundant inner header must be removed')
    assert.ok(!panel.includes('session__new'), 'giant inner + New button must be removed')
    assert.ok(panel.includes('onSessionChrome'), 'panel must mirror chrome state to the shell')
    assert.ok(!existsSync(join(process.cwd(), 'src', 'renderer', 'src', 'features', 'sessions', 'SessionHeaderBar.tsx')), 'deleted header component must stay deleted')
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

  it('emblem renders the official starkicon asset (placeholder retired)', () => {
    const mark = readRenderer('components/StarkMark.tsx')
    assert.ok(mark.includes('StarkMark'), 'StarkMark component must exist')
    assert.ok(mark.includes('<img'), 'StarkMark must render the official image')
    assert.ok(mark.includes('STARK_ICON_URL') || mark.includes('starkicon.png'), 'StarkMark must render the real starkicon asset')
    assert.ok(!mark.includes('stark-mark__fallback'), 'CSS placeholder must no longer be rendered in production branding')
    assert.ok(mark.includes('official starkicon'), 'component must document the official-asset contract')
    const css = readRenderer('components/StarkMark.css')
    assert.ok(!css.includes('stark-mark__fallback'), 'placeholder fallback CSS must be removed')
    assert.ok(!css.includes('linear-gradient(135deg, var(--stark-lime)'), 'temporary gradient placeholder must be removed')
    assert.ok(css.includes('object-fit: contain'), 'official asset must preserve aspect ratio')
  })

  it('idle UI shows both brand accents with magenta in AI roles', () => {
    const chromeCss = readRenderer('layouts/AppChrome.css')
    assert.ok(chromeCss.includes('.app-chrome__tab-dot'), 'session identity must carry a magenta cue in the chrome tab')
    const sessionCss = readRenderer('features/sessions/session.css')
    assert.ok(sessionCss.includes('.session__composer .session__mode[aria-pressed="true"]'), 'Ask selected must read lime')
    assert.ok(sessionCss.includes('.session__composer .session__mode--work[aria-pressed="true"]'), 'Work selected must read magenta')
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.workspace__tab--context.workspace__tab--active'), 'Context tab must read magenta')
    assert.ok(explorerCss.includes('.workspace__tab--review.workspace__tab--active'), 'Review tab must read lime')
    const chrome = readRenderer('layouts/AppChrome.css')
    assert.ok(chrome.includes('var(--stark-magenta-dim)'), 'account control may carry only a subtle magenta detail')
    const settingsCss = readRenderer('features/sessions/StarkSettingsSurface.css')
    assert.ok(settingsCss.includes('.stark-settings__nav-item--ai'), 'AI settings navigation must carry the magenta indicator')
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

  it('no permanent bottom bar exists and no replacement footer was added', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(!home.includes('workbench-status'), 'the bottom status strip must be gone')
    assert.ok(!home.includes('Status bar'), 'no status-bar region may remain')
    assert.ok(!home.includes('<footer'), 'no footer element may replace the bar')
    const css = readRenderer('pages/HomePage.css')
    assert.ok(!css.includes('.workbench-status'), 'no footer CSS may remain')
    assert.ok(home.includes('stage-workarea'), 'the work area must extend to the content bottom')
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(surface.includes('About'), 'version/platform must stay reachable under Settings → About')
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
    for (const region of ['<AppChrome', '<Explorer', 'stage-workarea']) {
      assert.ok(home.includes(region), `shell must keep ${region}`)
    }
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const feature of ['<WorkspaceToolsDrawer', '<SearchPanel', '<GitPanel', '<ChangesPanel', '<CodeEditor', '<TerminalPanel', 'handleSaveGesture', '<ContextTab']) {
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
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('Continue with Looplink'), 'Looplink must remain reachable in the session overflow')
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

  it('schema remains v19 with no migration 020', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear for a visual pass')
    const index = readSource('src', 'main', 'database', 'migrations', 'index.ts')
    assert.ok(index.includes('019'), 'migration registry must include v19')
  })
})
