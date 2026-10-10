import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 D05 structural proof: the OpenCode-inspired STARK shell —
 * primary session pane + optional secondary workspace pane, overlay
 * tools drawer, composer dock with docks above it, dedicated settings
 * surface — with zero main/preload/IPC/schema changes.
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

describe('stage 31 D05 shell proof', () => {
  it('1. desktop session stays mounted when the file editor opens', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('{sessionNode}'), 'session must render unconditionally')
    assert.ok(!explorer.includes("hidden={canvasView"), 'session must not hide behind a canvas conditional')
    assert.ok(explorer.includes("secondaryUiDispatch({ type: 'open-tab', tab: 'file' })"), 'file open must target the secondary pane')
  })

  it('2. opening a file opens the secondary workspace', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('state.preview !== null'), 'file preview must drive secondary visibility')
    assert.ok(explorer.includes('hasFile'), 'file presence must gate the secondary pane')
  })

  it('3. review opens the secondary workspace without hiding the session', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<TransactionReview'), 'transaction review must render')
    assert.ok(explorer.includes('<ChangeSetReview'), 'change-set review must render')
    assert.ok(explorer.includes('<GitDiffViewer'), 'git diffs must render')
    assert.ok(explorer.includes('{sessionNode}'), 'session must remain mounted alongside review')
  })

  it('4. context exists in the secondary workspace', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<ContextTab'), 'secondary pane must host the Context tab')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes('context'), 'pane must offer a Context tab')
  })

  it('5. large attached-context drawer is gone from the conversation flow', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('aria-label="Attached context"'), 'conversation must not host the context drawer')
    assert.ok(panel.includes('session__context-chips'), 'composer must carry compact context chips')
  })

  it('6. explorer, search, changes, and git are available through the drawer', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const feature of ['<SearchPanel', '<GitPanel', '<ChangesPanel', '<ChangeSetPanel', 'TreeNode']) {
      assert.ok(explorer.includes(feature), `drawer must host ${feature}`)
    }
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const activity of ['explorer', 'search', 'changes', 'git']) {
      assert.ok(rail.includes(activity), `drawer must offer ${activity}`)
    }
  })

  it('7. closed drawer consumes no permanent layout column', () => {
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(drawer.includes('if (!open)'), 'closed drawer must unmount')
    assert.ok(drawer.includes('return null'), 'closed drawer must reserve nothing')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('position: absolute'), 'open drawer must overlay, not grid')
  })

  it('8. terminal stacks in the secondary region', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<TerminalPanel'), 'stack must host the PTY panel')
    assert.ok(explorer.includes('terminalOpen'), 'stack must be user-controlled')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes('workspace__terminal'), 'terminal must stack beneath secondary content')
    assert.ok(pane.includes('terminalNode'), 'pane must own the terminal stack slot')
  })

  it('9. closed terminal reserves no large area', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(!explorer.includes('bottom-drawer'), 'no global drawer may reserve height')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(pane.includes('terminalOpen &&'), 'terminal must mount only while open')
  })

  it('10. settings no longer render inline in the message timeline', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!panel.includes('aria-label="AI settings"'), 'inline settings block must be gone')
    assert.ok(panel.includes('<StarkSettingsSurface'), 'settings must render in the dedicated surface')
  })

  it('11. AccountSection is mounted in settings', () => {
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    assert.ok(surface.includes('<AccountSection'), 'existing AccountSection must be reachable under Settings')
  })

  it('12. composer contains Ask, Work, Propose, and Send', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const feature of ['Ask', 'Work', 'Propose change', 'Send', 'Composer mode', 'Message composer']) {
      assert.ok(panel.includes(feature), `composer must contain ${feature}`)
    }
  })

  it('13. pending approval is adjacent to the composer', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__dock'), 'approval must dock above the composer')
    assert.ok(panel.indexOf('session__dock') < panel.indexOf('session__composer--'), 'dock must precede the composer')
    assert.ok(panel.includes('Deny') && panel.includes('Approve'), 'Deny/Approve must stay exact')
  })

  it('14. looplink remains reachable', () => {
    const chrome = readRenderer('layouts/AppChrome.tsx')
    assert.ok(chrome.includes('Continue with Looplink'), 'Looplink must live in the session tab overflow')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleContinueWithLooplink'), 'Looplink behavior must be unchanged')
  })

  it('15. existing feature inventory remains reachable', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const feature of ['handleEdit', 'Attach selection', 'Attach file', 'handleAccept', 'handleReject', 'handleRollback', 'onSelectDiff', 'onOpenFile']) {
      assert.ok(explorer.includes(feature), `explorer must keep ${feature}`)
    }
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const feature of ['handleNew', 'handleSelect', 'handleSend', 'handleProposalMode', 'handleOpenPreview', 'handleStopRuntime', 'handleApprovalDecision']) {
      assert.ok(panel.includes(feature), `session must keep ${feature}`)
    }
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    for (const feature of ['Save Heart', 'Save Recovery', 'Save permissions', 'Save usage routing', 'Use model']) {
      assert.ok(surface.includes(feature), `settings must keep ${feature}`)
    }
  })

  it('16. narrow layout supports single-pane switching', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('workspace__narrow-switch'), 'narrow switch must exist')
    assert.ok(explorer.includes('data-canvas-view'), 'switch must drive pane visibility')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('@media (max-width: 1099px)'), 'desktop split must yield below 1100px')
  })

  it('17. no filename wrapping', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('white-space: nowrap'), 'filenames must not wrap')
    assert.ok(css.includes('text-overflow: ellipsis'), 'long filenames must ellipsize')
  })

  it('18. no new IPC surface in the renderer shell', () => {
    for (const file of [
      'layouts/AppChrome.tsx',
      'layouts/WorkspaceToolsDrawer.tsx',
      'pages/HomePage.tsx',
      'features/explorer/Explorer.tsx',
      'features/workspace/WorkspaceSecondaryPane.tsx',
      'features/sessions/SessionPanel.tsx',
      'features/sessions/StarkSettingsSurface.tsx',
      'features/sessions/ContextTab.tsx',
      'components/icons/StarkIcon.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
    }
  })

  it('19. schema remains v19', () => {
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
    const index = readSource('src', 'main', 'database', 'migrations', 'index.ts')
    assert.ok(index.includes('019'), 'migration registry must include v19')
  })

  it('20. main and preload boundaries are untouched by the shell', () => {
    for (const file of [
      'layouts/AppChrome.tsx',
      'layouts/WorkspaceToolsDrawer.tsx',
      'features/workspace/WorkspaceSecondaryPane.tsx',
      'features/sessions/StarkSettingsSurface.tsx',
      'features/sessions/ContextTab.tsx',
      'components/icons/StarkIcon.tsx'
    ]) {
      const source = readRenderer(file)
      assert.ok(!source.includes('src/main'), `${file} must not reach into main`)
      assert.ok(!source.includes('src/preload'), `${file} must not reach into preload`)
      assert.ok(!source.includes('setInterval'), `${file} must add no timers`)
    }
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(!home.includes('setInterval'), 'shell must add no timers')
  })

  it('single state ownership survives the visual split', () => {
    const tab = readRenderer('features/sessions/ContextTab.tsx')
    assert.ok(!tab.includes('sessionContextDraftReducer'), 'ContextTab must reuse the HomePage draft reducer via props')
    const surface = readRenderer('features/sessions/StarkSettingsSurface.tsx')
    for (const reducer of ['providerPanelReducer', 'heartPanelReducer', 'recoveryPanelReducer', 'usagePanelReducer', 'capabilityPanelReducer']) {
      assert.ok(!surface.includes(reducer), `settings surface must not duplicate ${reducer}`)
    }
  })
})
