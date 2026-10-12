import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Explorer CRUD surface guarantees: VS Code-style file operations as
 * direct human actions (header actions, custom context menu, inline
 * create/rename, Trash confirmation), with tree sync and no AI
 * transaction involvement.
 */
function readRenderer(relative: string): string {
  const file = join(process.cwd(), 'src', 'renderer', 'src', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

describe('explorer CRUD surface', () => {
  it('offers compact header actions with tooltips', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('aria-label="Explorer actions"'), 'header actions toolbar must exist')
    for (const label of ['aria-label="New file"', 'aria-label="New folder"', 'aria-label="Refresh explorer"', 'aria-label="Collapse all folders"']) {
      assert.ok(explorer.includes(label), `header must offer ${label}`)
    }
    assert.ok(explorer.includes('title="New file"'), 'actions must tooltip')
    assert.ok(explorer.includes('name="file-plus"'), 'new file must use the FilePlus glyph')
    assert.ok(explorer.includes('name="folder-plus"'), 'new folder must use the FolderPlus glyph')
    assert.ok(explorer.includes("type: 'collapse-all'"), 'collapse-all must flow through the tree reducer')
  })

  it('opens a STARK-owned context menu (never browser-native)', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('onContextMenu'), 'rows must intercept right-click')
    assert.ok(explorer.includes('<ExplorerContextMenu'), 'custom menu surface must render')
    const menus = readRenderer('features/explorer/ExplorerTreeMenus.tsx')
    assert.ok(menus.includes("role=\"menu\""), 'menu must expose the menu role')
    assert.ok(menus.includes('createPortal'), 'menu must portal above tree clipping')
    assert.ok(!menus.includes('contextmenu'), 'no browser-native menu wiring may exist')
    for (const item of ['New File', 'New Folder', 'Rename', 'Delete', 'Refresh']) {
      assert.ok(menus.includes(item), `menu must offer ${item}`)
    }
  })

  it('creates and renames inline with Enter-commit and Escape-cancel', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('explorer__inline-input'), 'inline editable rows must exist')
    assert.ok(explorer.includes("key === 'Enter'"), 'Enter must commit inline edits')
    const escapes = explorer.match(/key === 'Escape'/g) ?? []
    assert.ok(escapes.length >= 2, 'Escape must cancel both inline create and rename')
    assert.ok(explorer.includes('createExplorerFile') && explorer.includes('createExplorerFolder'), 'commits must use the narrow CRUD bridge')
    assert.ok(explorer.includes('renameExplorerEntry'), 'renames must use the narrow CRUD bridge')
    // Inline rename stays in the same parent: the commit sends only
    // the leaf name, never a destination path (no move operation).
    assert.ok(explorer.includes('newName'), 'rename must send a leaf name')
    assert.ok(!explorer.includes('moveExplorerEntry'), 'no move operation may exist')
  })

  it('confirms deletes into the system Trash (never permanent)', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('trashExplorerEntry'), 'deletes must use the Trash bridge')
    assert.ok(explorer.includes('<ExplorerDeleteConfirm'), 'delete must require confirmation')
    const menus = readRenderer('features/explorer/ExplorerTreeMenus.tsx')
    assert.ok(menus.includes('system Trash'), 'confirmation must name the Trash destination')
    assert.ok(menus.includes('aria-label={`Delete'), 'confirmation must be an alertdialog')
    assert.ok(menus.includes('Move to Trash'), 'confirm action must say Move to Trash')
    const crud = readRenderer('lib/explorer-crud-api.ts')
    assert.ok(!crud.includes('rmSync') && !crud.includes('unlink'), 'renderer must never delete directly')
  })

  it('syncs the tree immediately without rebuilding app state', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('refreshCrudPath'), 'CRUD must refresh the affected parent')
    assert.ok(explorer.includes('loadPreviewFile(result.relativePath)'), 'created files must open cleanly')
    assert.ok(explorer.includes("dispatch({ type: 'preview-cleared' })"), 'trashed-open files must clear the preview')
  })

  it('blocks renaming dirty open files instead of corrupting them', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('Save or discard your changes before renaming this file.'), 'dirty rename must explain itself')
  })

  it('keeps user CRUD out of AI change transactions', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    // Bound exactly to the CRUD handler block (human-action handlers
    // only — later AI proposal flows live outside this span).
    const start = explorer.indexOf('Direct human file operations')
    const end = explorer.indexOf('function loadPreviewFile', start)
    assert.ok(start >= 0 && end > start, 'CRUD handler block must exist')
    const crudRegion = explorer.slice(start, end)
    assert.ok(!crudRegion.includes('createFileChange'), 'CRUD handlers must not create change transactions')
    assert.ok(!crudRegion.includes('acceptChangeTransaction'), 'CRUD handlers must not accept transactions')
    assert.ok(!crudRegion.includes('rollbackChangeTransaction'), 'CRUD handlers must not roll back transactions')
    const state = readRenderer('features/explorer/explorer-crud-state.ts')
    assert.ok(!state.includes('transaction'), 'CRUD state must not know transactions')
  })
})
