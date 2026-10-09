import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static content-safety guarantee: the Explorer and Search panel render
 * file contents and previews as plain React text. Any HTML injection
 * primitive fails this test. Runs against repository source (cwd is the
 * repo root via npm).
 */
function readExplorerSource(): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', 'features', 'explorer', 'Explorer.tsx')
  assert.ok(existsSync(file), 'Explorer source must exist')
  return readFileSync(file, 'utf8')
}

function readSearchSource(): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', 'features', 'search', 'SearchPanel.tsx')
  assert.ok(existsSync(file), 'Search panel source must exist')
  return readFileSync(file, 'utf8')
}

function readChangesSource(name: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', 'features', 'changes', name)
  assert.ok(existsSync(file), `Changes source ${name} must exist`)
  return readFileSync(file, 'utf8')
}

function readEditorSource(name: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', 'features', 'editor', name)
  assert.ok(existsSync(file), `Editor source ${name} must exist`)
  return readFileSync(file, 'utf8')
}

describe('explorer content safety', () => {
  it('never injects file content as HTML', () => {
    const source = readExplorerSource()
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `Explorer must not contain ${forbidden}`)
    }
  })

  it('renders file previews through the read-only Monaco surface', () => {
    const source = readExplorerSource()
    assert.ok(source.includes('<CodeEditor'), 'preview must use the Monaco CodeEditor')
    assert.ok(source.includes('readOnly'), 'preview surface must be read-only')
    assert.ok(source.includes('buildDocumentUri'), 'preview models must use synthetic URIs')
  })

  it('routes editing through Monaco and transactions, never raw HTML or direct saves', () => {
    const source = readExplorerSource()
    assert.ok(source.includes('<CodeEditor'), 'file surfaces must use the Monaco CodeEditor')
    assert.ok(!source.includes('<textarea'), 'temporary textarea editor is retired')
    assert.ok(source.includes('createFileChange'), 'proposals must flow through Change Transactions')
    assert.ok(!source.includes('writeWorkspaceTextFile'), 'human editing must not invoke direct saves')
    assert.ok(source.includes('{editor.saveError'), 'save errors must render as text')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `Explorer editor must not contain ${forbidden}`)
    }
  })

  it('renders transaction diffs through the read-only Monaco DiffEditor', () => {
    const review = readChangesSource('TransactionReview.tsx')
    assert.ok(review.includes('<TransactionDiffEditor'), 'review must use the diff editor')
    assert.ok(!review.includes('<textarea'), 'review must not use a textarea')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!review.includes(forbidden), `TransactionReview must not contain ${forbidden}`)
    }
  })

  it('creates Monaco models mount-once so typing never recreates them', () => {
    for (const name of ['CodeEditor.tsx', 'TransactionDiffEditor.tsx']) {
      const source = readEditorSource(name)
      assert.ok(source.includes('mountProps'), `${name} must capture mount-once document props`)
      assert.ok(!source.includes('}, [documentUri'), `${name} must not recreate models per prop change`)
    }
    const editor = readEditorSource('CodeEditor.tsx')
    assert.ok(!editor.includes('}, [beforeUri'), 'CodeEditor must not track diff props')
  })

  it('keeps standard editing affordances enabled by configuration', () => {
    const source = readEditorSource('CodeEditor.tsx')
    // The editable surface must stay undoable, searchable, and menu
    // capable: readOnly is prop-driven (preview true, edit false) and
    // nothing disables suggestions, context menus, or find.
    assert.ok(!source.includes('readOnly: true'), 'edit surface must not hard-disable editing')
    for (const forbidden of ['quickSuggestions: false', 'contextmenu: false', 'find: { enabled: false }', 'dragAndDrop: false']) {
      assert.ok(!source.includes(forbidden), `CodeEditor must not contain ${forbidden}`)
    }
    assert.ok(source.includes('readOnly,'), 'readOnly must follow the preview/edit mode prop')
  })

  it('keeps Monaco surfaces string-only with safe document identity', () => {
    for (const name of ['CodeEditor.tsx', 'TransactionDiffEditor.tsx', 'editor-setup.ts']) {
      const source = readEditorSource(name)
      for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html', 'node:fs', 'ipcRenderer']) {
        assert.ok(!source.includes(forbidden), `editor/${name} must not contain ${forbidden}`)
      }
    }
    const setup = readEditorSource('editor-setup.ts')
    for (const expected of ['editor.worker?worker&url', 'json.worker?worker&url', 'new Worker(', "type: 'module'"]) {
      assert.ok(setup.includes(expected), `editor-setup must use local workers (${expected})`)
    }
    assert.ok(
      setup.includes("window.location.protocol === 'file:'"),
      'worker construction must match the serving environment (classic for packaged file://, module for dev server ESM)'
    )
    for (const forbidden of ['cdn', 'https://', 'http://']) {
      assert.ok(!setup.includes(forbidden), `editor-setup must not reference remote origins`)
    }
  })

  it('routes all navigation through the shared discard guard', () => {
    const source = readExplorerSource()
    assert.ok(source.includes('confirmDiscardUnsavedDraft'), 'file/search selection must consult the discard guard')
    assert.ok(source.includes('setUnsavedDraft'), 'the editor must publish its dirty flag')
  })

  it('transaction review renders the diff through strings only', () => {
    const source = readChangesSource('TransactionReview.tsx')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `TransactionReview must not contain ${forbidden}`)
    }
    assert.ok(source.includes('beforeContent={file.beforeContent}'), 'checkpoint must pass as a string')
    assert.ok(source.includes('afterContent={file.proposedContent}'), 'proposal must pass as a string')
    assert.ok(source.includes('{actionError}'), 'action errors must render as text')
  })

  it('changes history renders entries as inert text only', () => {
    const source = readChangesSource('ChangesPanel.tsx')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `ChangesPanel must not contain ${forbidden}`)
    }
    assert.ok(source.includes('{entryTitle(transaction)}'), 'history entries must render as text')
  })

  it('search previews never inject HTML', () => {
    const source = readSearchSource()
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `Search must not contain ${forbidden}`)
    }
    assert.ok(source.includes('match.preview'), 'search must render preview as text')
    assert.ok(source.includes('<mark'), 'literal query highlighting must use safe React segments')
  })
})
