import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Stage 31 workbench layout guarantees: the ready-state STARK shell is
 * a bounded viewport of primary session pane + contextual secondary
 * pane (Review | Context | file) with the terminal stacked beneath the
 * secondary content. The tools drawer overlays on demand. Monaco
 * receives non-collapsing flex sizing, and the toolbar exposes Edit /
 * Review change without a direct Save.
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

  it('Edit action is visible when a file is selected in read-only mode', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('<EditorToolbar'), 'file panes must render through the shared toolbar')
    assert.ok(source.includes('Edit'), 'read-only toolbar must expose an Edit action')
    assert.ok(source.includes('<button'), 'Edit action must be a visible button')
    assert.ok(source.includes('handleEdit'), 'Edit action must enter edit mode')
  })

  it('Review change is visible while editing dirty content, with no direct Save', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('Review change'), 'editing toolbar must expose Review change')
    assert.ok(source.includes('Cancel'), 'editing toolbar must expose Cancel')
    assert.ok(source.includes('<CodeEditor'), 'editing must use Monaco, not a textarea')
    assert.ok(source.includes('<TerminalPanel'), 'terminal must stay stacked in the secondary region')
    assert.ok(!source.includes('<textarea'), 'editing must not use a separate textarea')
    for (const forbidden of ['>Save<', '>Save file<', 'onSave', 'handleSave']) {
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
