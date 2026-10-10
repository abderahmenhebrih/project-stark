import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Directly-editable file editor guarantees (mini UI fix: no file
 * action toolbar — Monaco begins directly beneath the tab strip).
 *
 * Human typing edits a volatile draft; Ctrl+S opens the existing
 * Review change flow (Change Transaction → Accept). Format / Attach
 * live in the editor right-click menu. Read-only stays only where
 * genuinely required (mixed-ending files, Git diffs, review diffs).
 * Runs against repository source (cwd is the repo root via npm).
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('directly editable file editor', () => {
  it('opens Explorer files editable immediately with no Edit affordance', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(!source.includes('handleEdit'), 'no Edit-mode entry point may remain')
    assert.ok(!source.includes('>Edit<'), 'no Edit button may remain in the file toolbar')
    assert.ok(source.includes('readOnly={false}'), 'the file editor must mount editable')
    assert.ok(
      source.includes('createEditorState(preview.content, preview.revision)'),
      'loaded files must enter edit state immediately'
    )
  })

  it('renders no file action toolbar under the tab strip', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const start = source.indexOf('function renderFileBody()')
    assert.ok(start >= 0, 'renderFileBody must exist')
    const end = source.indexOf('// Directory chevrons', start)
    assert.ok(end > start, 'file body must end')
    const body = source.slice(start, end)
    for (const gone of ['Review change', '>Edit<', 'handleEdit', 'Attach file</button>', 'Format Document</button>']) {
      assert.ok(!body.includes(gone), `file body must not render a toolbar with ${gone}`)
    }
    assert.ok(!body.includes('<EditorToolbar'), 'no toolbar component may remain in the file body')
    // Monaco mounts directly: canvas follows notices with no toolbar row.
    assert.ok(body.includes('<div className="editor-canvas">'), 'Monaco canvas must remain')
    assert.ok(body.includes('<CodeEditor'), 'file body must mount Monaco directly')
  })

  it('marks dirty files with a subtle tab dot and no status row', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('●'), 'dirty files must carry a tab indicator')
    assert.ok(!source.includes("'Unsaved changes'"), 'no dirty status row may remain')
    assert.ok(!source.includes("'No unsaved changes'"), 'no clean status row may remain')
  })

  it('wires Ctrl+S to the existing Review change flow, never a direct write', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('handleSaveGesture'), 'Ctrl+S must invoke the existing Review change flow')
    assert.ok(source.includes('handleReviewChange'), 'Review change handler must exist')
    assert.ok(source.includes('createFileChange'), 'human edits must flow through Change Transactions')
    assert.ok(source.includes('expectedRevision'), 'proposals must carry the reviewed revision')
    assert.ok(!source.includes('writeWorkspaceTextFile'), 'human editing must not invoke direct saves')
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('KeyCode.KeyS'), 'the save chord must be bound in the editor')
    assert.ok(editor.includes('onSaveRequest'), 'the save gesture must route to the parent flow')
    for (const forbidden of ['>Save<', '>Save file<', 'onSave={', 'handleSave(', 'writeWorkspaceTextFile']) {
      assert.ok(!source.includes(forbidden), `editing must not offer a direct Save (${forbidden})`)
    }
  })

  it('keeps Format and Attach in the editor right-click menu', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes("'Format Document'"), 'format must stay reachable by label')
    assert.ok(source.includes("'Attach selection'"), 'excerpt attach must stay reachable by label')
    assert.ok(source.includes("'Attach file'"), 'whole-file attach must stay reachable by label')
    assert.ok(source.includes('menuActions'), 'menu actions must flow into the editor')
    assert.ok(source.includes('handleFormatRequest'), 'format must run through the explicit handler')
    assert.ok(source.includes('formatDocumentWithPrettier'), 'format must use the narrow bridge helper')
    const editor = readRenderer('features/editor/CodeEditor.tsx')
    assert.ok(editor.includes('addAction'), 'menu items must use the native editor menu')
    assert.ok(editor.includes('contextMenuGroupId'), 'menu items must land in the right-click menu')
  })

  it('keeps review and diff panes read-only', () => {
    const diff = readRenderer('features/editor/TransactionDiffEditor.tsx')
    assert.ok(diff.includes('readOnly: true'), 'transaction diffs must stay read-only')
    const git = readRenderer('features/git/GitDiffViewer.tsx')
    assert.ok(git.includes('readOnly: true'), 'Git diffs must stay read-only')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('MIXED_EOL_MESSAGE'), 'mixed-ending files must stay read-only with an explanation')
  })

  it('keeps dirty guards and adds no renderer filesystem authority', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('confirmDiscardUnsavedDraft'), 'navigation must consult the discard guard')
    assert.ok(source.includes('setUnsavedDraft'), 'the editor must publish its dirty flag')
    for (const forbidden of ['node:fs', '.invoke(', 'ipcRenderer']) {
      assert.ok(!source.includes(forbidden), `Explorer must not contain ${forbidden}`)
    }
  })

  it('keeps AI changes on proposal review and Accept', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('<TransactionReview'), 'AI proposals must still open a review')
    assert.ok(source.includes('handleAccept'), 'Accept path must exist')
    assert.ok(source.includes('handleReject'), 'Reject path must exist')
    assert.ok(source.includes('handleRollback'), 'Rollback path must exist')
  })
})

describe('file pane close (X)', () => {
  it('close handler guards unsaved edits before clearing anything', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const start = source.indexOf('function handleCloseSecondaryPane()')
    assert.ok(start >= 0, 'close handler must exist')
    const body = source.slice(start, source.indexOf('\n  }\n', start))
    assert.ok(body.includes('confirmDiscardUnsavedDraft'), 'close must consult the discard guard first')
    assert.ok(
      body.indexOf('confirmDiscardUnsavedDraft') < body.indexOf('preview-cleared'),
      'declining the guard must keep the file open'
    )
  })

  it('close clears the presentation-only file/editor state', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const start = source.indexOf('function handleCloseSecondaryPane()')
    assert.ok(start >= 0, 'close handler must exist')
    const body = source.slice(start, source.indexOf('\n  }\n', start))
    assert.ok(body.includes("dispatch({ type: 'preview-cleared' })"), 'close must clear the preview')
    assert.ok(body.includes('setEditor(null)'), 'close must clear the editor draft')
    assert.ok(body.includes('setEditorSelection(null)'), 'close must clear the selection')
    assert.ok(body.includes('unpin-context'), 'close must release the context pin')
    assert.ok(body.includes('handleCloseReview'), 'close must close reviews')
  })

  it('close deletes nothing: no file, session, workspace, or app teardown', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    const start = source.indexOf('function handleCloseSecondaryPane()')
    assert.ok(start >= 0, 'close handler must exist')
    const body = source.slice(start, source.indexOf('\n  }\n', start))
    for (const forbidden of ['delete', 'destroy', 'removeSession', 'closeWorkspace', 'quit', 'reset']) {
      assert.ok(!body.includes(forbidden), `close handler must not contain ${forbidden}`)
    }
    assert.ok(source.includes('onClosePane={handleCloseSecondaryPane}'), 'pane X must stay wired to the close handler')
  })

  it('late file arrivals cannot resurrect a closed editor', () => {
    const source = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(source.includes('previewPathRef'), 'load tracking ref must exist')
    assert.ok(
      source.includes('file.relativePath === previewPathRef.current'),
      'late arrivals for deselected files must not create editor state'
    )
  })
})
