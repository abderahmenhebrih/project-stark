import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 workbench layout guarantees: the ready-state STARK shell is
 * a bounded viewport of primary session pane + contextual secondary
 * pane (Review | Context | file) with the terminal stacked beneath the
 * secondary content. The tools drawer overlays on demand. Monaco
 * receives non-collapsing flex sizing. Files open directly editable
 * with no file action toolbar; Ctrl+S opens Review change without a
 * direct Save.
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

describe('stage 31 workbench layout', () => {
  it('main ready layout uses a bounded viewport structure', () => {
    const shell = readRenderer('layouts/MainLayout.css')
    assert.ok(shell.includes('height: 100vh'), 'shell must bound to the viewport height')
    assert.ok(shell.includes('overflow: hidden'), 'shell must not scroll as a document')
    assert.ok(shell.includes('min-height: 0'), 'shell flex children must be allowed to shrink')
    const home = readRenderer('pages/HomePage.css')
    assert.ok(home.includes('stage-shell'), 'active workspace must render a stage shell')
    assert.ok(home.includes('stage-workarea'), 'shell must define a work area row')
    assert.ok(home.includes('overflow: hidden'), 'workbench areas must clip instead of page-scrolling')
    const homeTsx = readRenderer('pages/HomePage.tsx')
    assert.ok(homeTsx.includes('stage-shell'), 'HomePage must render the stage shell when active')
    assert.ok(homeTsx.includes('stage-workarea'), 'HomePage must render the work area when active')
  })

  it('session and secondary panes are siblings in the main workspace layout', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('workspace__session'), 'Explorer must render a session pane')
    assert.ok(source.includes('WorkspaceSecondaryPane'), 'Explorer must render a secondary pane')
    assert.ok(source.includes('workbench__editor'), 'secondary pane must host the editor pane')
    const sessionIndex = source.indexOf('workspace__session')
    const secondaryIndex = source.indexOf('<WorkspaceSecondaryPane')
    assert.ok(sessionIndex >= 0 && secondaryIndex > sessionIndex, 'session and secondary must be sibling panes')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('.workspace__session'), 'session must be styled as a workbench pane')
    assert.ok(css.includes('.workspace__secondary'), 'secondary must be styled as the contextual surface')
  })

  it('Monaco container has non-collapsing flex sizing', () => {
    const css = readRenderer('features/editor/editor.css')
    assert.ok(css.includes('.code-editor__frame'), 'Monaco frame CSS must exist')
    assert.ok(css.includes('flex: 1'), 'Monaco frame must grow to fill the editor pane')
    assert.ok(css.includes('min-height: 0'), 'Monaco frame must not collapse its parent')
    assert.ok(css.includes('min-width: 0'), 'Monaco frame must not overflow horizontally')
    assert.ok(!css.includes('height: 320px'), 'Monaco frame must not use a fixed tiny height')
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.editor-canvas'), 'editor canvas must own the flex sizing context')
    assert.ok(explorerCss.includes('flex: 1'), 'editor canvas must fill remaining height')
  })

  it('files open directly editable with no Edit button or read-only step', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('<EditorToolbar'), 'file panes must render through the shared toolbar')
    assert.ok(!source.includes('handleEdit'), 'no Edit-mode entry point may remain')
    assert.ok(!source.includes('>Edit<'), 'no Edit button may remain in the file toolbar')
    assert.ok(source.includes('readOnly={false}'), 'the file editor must mount editable')
    assert.ok(source.includes('createEditorState(preview.content, preview.revision)'), 'loaded files must enter edit state immediately')
  })

  it('session/secondary split is a free continuous drag with pixel minimums', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('workspace__resize'), 'divider must exist')
    assert.ok(source.includes('role="separator"'), 'divider must expose the separator role')
    assert.ok(source.includes('col-resize') || source.includes('Resize session and workspace panes'), 'divider must be discoverable')
    assert.ok(source.includes('onPointerDown'), 'drag must start on pointerdown')
    assert.ok(source.includes('onPointerMove'), 'drag must track pointermove')
    assert.ok(source.includes('onPointerUp'), 'drag must end on pointerup')
    assert.ok(source.includes('onPointerCancel'), 'drag must end on pointercancel')
    assert.ok(source.includes('setPointerCapture'), 'drag must capture the pointer')
    assert.ok(source.includes('clampSplitPct'), 'drag must clamp through the shared bounds helper')
    assert.ok(!source.includes('Math.min(68, Math.max(30'), 'no fixed preset clamp may remain')
    // Both panes follow the dragged percentage (grow locked to zero).
    assert.ok(source.includes('flexGrow: 0'), 'split must pin flex-grow so the ratio tracks the drag')
    assert.ok(source.includes('100 - secondaryUi.splitPct'), 'secondary width must complement the session width')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('min-width: 320px'), 'session keeps a usable minimum')
    assert.ok(css.includes('min-width: 420px'), 'secondary keeps a usable minimum')
    assert.ok(css.includes('.workspace__resize::after'), 'divider must offer an expanded invisible hit target')
    assert.ok(css.includes('.workspace__resize:active'), 'dragging must show affordance without a permanent bright line')
  })

  it('splitter renders only with the secondary pane and cleans up listeners', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const resizeIndex = source.indexOf('workspace__resize')
    assert.ok(resizeIndex >= 0, 'divider must exist')
    const guardStart = source.lastIndexOf('{secondaryOpen && (', resizeIndex)
    assert.ok(guardStart >= 0 && guardStart < resizeIndex, 'divider must render only when the secondary pane exists')
    assert.ok(source.includes("window.addEventListener('resize'"), 'window resize must preserve the ratio')
    assert.ok(source.includes("window.removeEventListener('resize'"), 'window listener must be removed on cleanup')
    assert.ok(!source.includes('setInterval'), 'split must use no timers')
  })

  it('narrow single-pane behavior stays intact', () => {
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('@media (max-width: 1099px)'), 'narrow breakpoint must remain')
    assert.ok(css.includes('.workspace[data-canvas-view="session"] .workspace__resize'), 'handle must hide in narrow session view')
  })

  it('Ctrl+S opens Review change while dirty, with no direct Save', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('handleSaveGesture'), 'Ctrl+S must invoke the existing Review change flow')
    assert.ok(source.includes('handleReviewChange'), 'Review change handler must exist')
    assert.ok(source.includes('<CodeEditor'), 'editing must use Monaco, not a textarea')
    assert.ok(source.includes('<TerminalPanel'), 'terminal must stay stacked in the secondary region')
    assert.ok(!source.includes('<textarea'), 'editing must not use a separate textarea')
    for (const forbidden of ['>Save<', '>Save file<', 'onSave={', 'handleSave(', 'writeWorkspaceTextFile']) {
      assert.ok(!source.includes(forbidden), `editing must not offer a direct Save (${forbidden})`)
    }
  })

  it('Explorer, Search, and Changes are all available from the drawer', () => {
    const rail = readRenderer('features/explorer/ActivityRail.tsx')
    for (const label of ['Explorer', 'Search', 'Changes']) {
      assert.ok(rail.includes(label), `rail must include ${label}`)
    }
    assert.ok(rail.includes('role="tablist"'), 'activity navigation must use tabs')
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('<WorkspaceToolsDrawer'), 'workbench must render the tools drawer')
    assert.ok(source.includes('<SearchPanel'), 'Search must live in the drawer')
    assert.ok(source.includes('<ChangesPanel'), 'Changes history must live in the drawer')
    assert.ok(source.includes('workbench__sidebar-body'), 'drawer panels must scroll inside the drawer')
  })

  it('transaction review uses the secondary pane with a filling diff', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('<TransactionReview'), 'selecting history must open TransactionReview beside the session')
    assert.ok(explorer.includes("secondaryUiDispatch({ type: 'open-tab', tab: 'review' })"), 'review must reveal the secondary Review tab')
    const review = readRenderer('features/changes/TransactionReview.tsx')
    assert.ok(review.includes('<EditorToolbar'), 'review must reuse the shared editor toolbar')
    assert.ok(review.includes('<TransactionDiffEditor'), 'review must render the Monaco DiffEditor')
    assert.ok(review.includes("'Accept'"), 'pending review must expose Accept in the toolbar')
    assert.ok(review.includes("'Reject'"), 'pending review must expose Reject in the toolbar')
    const changesCss = readRenderer('features/changes/changes.css')
    assert.ok(changesCss.includes('.review__diff'), 'review diff must have a filling container')
    assert.ok(changesCss.includes('flex: 1'), 'review diff must fill the main area')
    const editorUses = (review.match(/<TransactionDiffEditor/g) ?? []).length
    assert.equal(editorUses, 1, 'review must render exactly one diff in the main area')
  })

  it('empty state communicates the Monaco editor without fake toolbar clutter', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('Select a file to open'), 'empty pane must say "Select a file to open"')
    assert.ok(!source.includes('Select a file to preview'), 'legacy preview copy must be retired')
  })

  it('does not introduce a giant duplicate nested layout', () => {
    const home = readRenderer('pages/HomePage.tsx')
    assert.ok(!home.includes('<textarea'), 'workbench must not add ad-hoc editors outside Monaco')
    assert.ok(!home.includes('chat'), 'workbench must not add a chat input')
    assert.ok(!home.includes('Chat'), 'workbench must not add a chat input')
    const workspace = readRenderer('features/workspace/WorkspaceSection.tsx')
    assert.ok(workspace.includes('Open project folder'), 'welcome surface must keep its open action')
    assert.ok(workspace.includes('workspace__recent-list'), 'welcome surface must keep its recent list')
    const drawer = readRenderer('layouts/WorkspaceToolsDrawer.tsx')
    assert.ok(!drawer.includes('<WorkspaceSection'), 'drawer must use the compact title, not a project card')
  })
})

describe('secondary close returns the session to full width', () => {
  it('session and secondary split styles apply only while the secondary pane is open', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    // Both inline split styles (session flexBasis + secondary complement)
    // must be gated on secondaryOpen — never on the stored ratio alone.
    let from = 0
    let gated = 0
    while (true) {
      const at = source.indexOf('splitPct !== null', from)
      if (at < 0) {
        break
      }
      gated += 1
      assert.ok(
        source.slice(Math.max(0, at - 40), at).includes('secondaryOpen &&'),
        'every split style must be gated on secondaryOpen so closing clears it'
      )
      from = at + 1
    }
    assert.equal(gated, 2, 'exactly the session and secondary split styles must exist')
    assert.ok(source.includes('secondaryOpen && secondaryUi.splitPct !== null'), 'gate must read secondaryOpen first')
  })

  it('session falls back to full-width single-pane CSS when closed', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('className="session-frame"'), 'session frame must exist')
    // Ungated fallback: style resolves to undefined with no width/basis.
    const frameAt = source.indexOf('className="session-frame"')
    const frameSlice = source.slice(frameAt, frameAt + 600)
    assert.ok(frameSlice.includes(': undefined'), 'closed session must drop inline sizing entirely')
    assert.ok(!frameSlice.includes('width:'), 'closed session must not pin any width')
    const css = readRenderer('features/explorer/Explorer.css')
    const onlyChild = css.match(/\.workspace__session > \.session-frame:only-child\s*\{[^}]*\}/)
    assert.ok(onlyChild !== null, 'only-child single-pane rule must exist')
    assert.ok(onlyChild[0].includes('flex: 1 1 100%'), 'lone session must flex to the full row')
    assert.ok(!onlyChild[0].includes('max-width'), 'lone session must carry no width cap')
  })

  it('secondary pane unmounts on close and reserves zero layout width', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const paneAt = source.indexOf('<WorkspaceSecondaryPane')
    assert.ok(paneAt >= 0, 'secondary pane must exist')
    const guardStart = source.lastIndexOf('{secondaryOpen && (', paneAt)
    assert.ok(guardStart >= 0 && guardStart < paneAt, 'secondary pane must render only when open (unmount, never hide)')
    const pane = readRenderer('features/workspace/WorkspaceSecondaryPane.tsx')
    assert.ok(!pane.includes('visibility'), 'pane must not hide via visibility')
    assert.ok(!pane.includes('opacity'), 'pane must not hide via opacity')
    assert.ok(!pane.includes('display: none') && !pane.includes("display: 'none'"), 'pane must not hide via display')
  })

  it('splitter unmounts with the secondary pane: no gap, no strip, no leak', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const resizeAt = source.indexOf('workspace__resize')
    assert.ok(resizeAt >= 0, 'divider must exist')
    const guardStart = source.lastIndexOf('{secondaryOpen && (', resizeAt)
    assert.ok(guardStart >= 0 && guardStart < resizeAt, 'divider must unmount with the secondary pane')
    assert.ok(!source.includes("window.addEventListener('pointermove'"), 'drag must use element handlers, no window listeners')
    assert.ok(!source.includes("window.addEventListener('pointerup'"), 'drag end must use element handlers, no window listeners')
    assert.ok(source.includes('draggingRef.current = false'), 'drag state must reset on release')
    assert.ok(!source.includes('setInterval'), 'split must use no timers')
  })

  it('stored split ratio survives close and restores on reopen', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    // Close path clears content (preview/editor/review/context) but must
    // never wipe the stored ratio.
    const closeAt = source.indexOf('function handleCloseSecondaryPane')
    assert.ok(closeAt >= 0, 'close handler must exist')
    const resizeAt = source.indexOf('function handleResizeStart', closeAt)
    const closeBody = source.slice(closeAt, resizeAt)
    assert.ok(!closeBody.includes('set-split'), 'closing must preserve the stored split ratio')
    assert.ok(!closeBody.includes('splitPct'), 'closing must not touch split state at all')
    assert.ok(closeBody.includes('confirmDiscardUnsavedDraft'), 'unsaved guard must stay on the close path')
    // Reopen paths only switch tabs; the reducer spread keeps splitPct.
    assert.ok(source.includes("return state.tab === action.tab ? state : { ...state, tab: action.tab }"), 'open-tab must preserve the stored ratio')
    // The only ratio reset is the workspace-change reset (new workspace).
    const resets = source.split("secondaryUiDispatch({ type: 'reset' })").length - 1
    assert.equal(resets, 1, 'split preference resets only on workspace change')
    const resetAt = source.indexOf("secondaryUiDispatch({ type: 'reset' })")
    assert.ok(source.slice(Math.max(0, resetAt - 300), resetAt).includes('workspaceId'), 'reset must be scoped to workspace change')
  })

  it('secondaryOpen still derives from open content, and drag math is untouched', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(
      source.includes('const secondaryOpen = hasReviewTab || hasFile || secondaryUi.contextPinned || terminalOpen'),
      'open state must derive from content so clearing content closes the pane'
    )
    assert.ok(source.includes('((event.clientX - rect.left) / rect.width) * 100'), 'drag percentage math must be unchanged')
    assert.ok(source.includes('clampSplitPct(pct, rect.width)'), 'drag clamping must be unchanged')
    assert.ok(source.includes('100 - secondaryUi.splitPct'), 'secondary complement width must be unchanged')
  })

  it('window resize and narrow breakpoint behavior are unchanged', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes("window.addEventListener('resize'"), 'window resize must preserve the ratio')
    assert.ok(source.includes("window.removeEventListener('resize'"), 'window listener must be removed on cleanup')
    const css = readRenderer('features/explorer/Explorer.css')
    assert.ok(css.includes('@media (max-width: 1099px)'), 'narrow breakpoint must remain')
    assert.ok(css.includes('.workspace[data-canvas-view="session"] .workspace__resize'), 'handle must hide in narrow session view')
    assert.ok(css.includes('min-width: 320px'), 'session minimum must be unchanged')
    assert.ok(css.includes('min-width: 420px'), 'secondary minimum must be unchanged')
  })

  it('split fix adds no schema, IPC, or editor-semantics changes', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(!source.includes('ipcRenderer') && !source.includes('ipcMain'), 'fix must add no IPC surface')
    const frameAt = source.indexOf('className="session-frame"')
    const frameSlice = source.slice(frameAt, frameAt + 600)
    assert.ok(!frameSlice.includes('stark-api') && !frameSlice.includes('migration'), 'split styles must stay presentational')
    const migrations = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(migrations).map((name) => name.toLowerCase())
    assert.ok(files.includes('019-message-attachments.ts'), 'schema v19 must remain')
    assert.ok(!files.some((name) => name.startsWith('020-')), 'no schema migration may be added')
  })

  it('terminal claims pane space instead of sizing to content', () => {
    // Context on top, terminal below — but the terminal must read as a
    // real working area in both pre-start and running states, never a
    // content-sized preview box while Context takes the whole pane.
    const css = readRenderer('features/explorer/Explorer.css')
    const stack = css.match(/\.workspace__terminal\s*\{[^}]*\}/)
    assert.ok(stack !== null, 'terminal stack CSS must exist')
    assert.ok(stack[0].includes('flex: 3 1 0'), 'terminal must claim the larger pane share')
    assert.ok(stack[0].includes('min-height: 280px'), 'terminal must keep a comfortable floor')
    assert.ok(stack[0].includes('max-height: 70%'), 'terminal must leave room for the body above')
    const body = css.match(/\.workspace__pane-body\s*\{[^}]*\}/)
    assert.ok(body !== null, 'pane body CSS must exist')
    assert.ok(body[0].includes('flex: 2 1 0'), 'context body must take the smaller share')
    assert.ok(body[0].includes('min-height: 120px'), 'context body must stay readable when compact')
    const secondary = css.match(/\.workspace__secondary\s*\{[^}]*\}/)
    assert.ok(secondary !== null && secondary[0].includes('overflow: hidden'), 'pane must clip instead of overflowing')
    assert.ok(!secondary[0].includes('overflow-x'), 'pane must add no horizontal overflow behavior')
  })

  it('terminal panel stretches to its stack in every state', () => {
    const css = readRenderer('features/terminal/TerminalPanel.css')
    const panel = css.match(/\.terminal\s*\{[^}]*\}/)
    assert.ok(panel !== null, 'terminal panel CSS must exist')
    assert.ok(panel[0].includes('flex: 1 1 auto'), 'panel must fill the stack before and after start')
    const viewport = css.match(/\.terminal__xterm\s*\{[^}]*\}/)
    assert.ok(viewport !== null, 'terminal canvas CSS must exist')
    assert.ok(viewport[0].includes('flex: 1 1 auto'), 'canvas must grow with the stack when running')
    assert.ok(!viewport[0].includes('height: 200px'), 'canvas must not pin a fixed preview height')
    const tab = readRenderer('features/sessions/ContextTab.tsx')
    assert.ok(tab.includes('ContextTab'), 'context surface must be untouched')
  })
})
