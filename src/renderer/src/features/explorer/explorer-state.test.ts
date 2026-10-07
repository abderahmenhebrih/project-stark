import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkspaceEntry } from '../../../../shared/workspace-files/types'
import { explorerReducer, initialExplorerState } from './explorer-state'

function fileEntry(name: string, parent: string): WorkspaceEntry {
  return { name, relativePath: parent === '' ? name : `${parent}/${name}`, kind: 'file', size: 3 }
}

function dirEntry(name: string, parent: string): WorkspaceEntry {
  return { name, relativePath: parent === '' ? name : `${parent}/${name}`, kind: 'directory', size: null }
}

describe('explorer state', () => {
  it('toggles expanded directories', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const expanded = explorerReducer(start, { type: 'toggle', path: 'src' })
    assert.deepEqual(expanded.expanded, ['src'])
    const collapsed = explorerReducer(expanded, { type: 'toggle', path: 'src' })
    assert.deepEqual(collapsed.expanded, [])
  })

  it('changing workspace clears prior explorer state', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const loaded = explorerReducer(start, {
      type: 'directory-loaded',
      workspaceId: 4,
      path: '',
      entries: [dirEntry('src', '')]
    })
    const selected = explorerReducer(loaded, { type: 'file-selected', path: 'a.txt' })
    const next = explorerReducer(selected, { type: 'workspace-changed', workspaceId: 7 })
    assert.equal(next.workspaceId, 7)
    assert.deepEqual(next.expanded, [])
    assert.deepEqual(next.entries, {})
    assert.equal(next.selectedPath, null)
    assert.equal(next.preview, null)
  })

  it('a directory result belongs to the correct workspace', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const loading = explorerReducer(start, { type: 'directory-loading', path: 'src' })
    assert.deepEqual(loading.loading, ['src'])
    const loaded = explorerReducer(loading, {
      type: 'directory-loaded',
      workspaceId: 4,
      path: 'src',
      entries: [fileEntry('a.txt', 'src')]
    })
    assert.deepEqual(loaded.loading, [])
    assert.deepEqual(loaded.entries['src'], [fileEntry('a.txt', 'src')])
  })

  it('stale results from an old workspace are ignored', () => {
    const start = { ...initialExplorerState(), workspaceId: 7 }
    const afterLateDirectory = explorerReducer(start, {
      type: 'directory-loaded',
      workspaceId: 4,
      path: 'src',
      entries: [fileEntry('a.txt', 'src')]
    })
    assert.deepEqual(afterLateDirectory.entries, {})
    const selected = explorerReducer(
      {
        ...start,
        selectedPath: 'b.txt',
        preview: { path: 'b.txt', content: null, loading: true, error: null, revision: null }
      },
      { type: 'file-loaded', workspaceId: 4, path: 'a.txt', content: 'stale', revision: 'a'.repeat(64) }
    )
    assert.equal(selected.preview?.content, null)
    assert.equal(selected.preview?.loading, true)
  })

  it('directory failures record per-path errors', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const failed = explorerReducer(start, {
      type: 'directory-failed',
      path: 'src',
      message: 'We couldn’t read this folder.'
    })
    assert.equal(failed.errors['src'], 'We couldn’t read this folder.')
    assert.deepEqual(failed.loading, [])
  })

  it('selecting a file sets preview state', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const selected = explorerReducer(start, { type: 'file-selected', path: 'a.txt' })
    assert.equal(selected.selectedPath, 'a.txt')
    assert.deepEqual(selected.preview, { path: 'a.txt', content: null, loading: true, error: null, revision: null })
    const loaded = explorerReducer(selected, {
      type: 'file-loaded',
      workspaceId: 4,
      path: 'a.txt',
      content: 'hello',
      revision: 'a'.repeat(64)
    })
    assert.deepEqual(loaded.preview, {
      path: 'a.txt',
      content: 'hello',
      loading: false,
      error: null,
      revision: 'a'.repeat(64)
    })
  })

  it('selecting another file replaces the preview', () => {
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const first = explorerReducer(
      explorerReducer(start, { type: 'file-selected', path: 'a.txt' }),
      { type: 'file-loaded', workspaceId: 4, path: 'a.txt', content: 'aaa', revision: 'b'.repeat(64) }
    )
    const second = explorerReducer(first, { type: 'file-selected', path: 'b.txt' })
    assert.equal(second.selectedPath, 'b.txt')
    assert.equal(second.preview?.content, null)
    assert.equal(second.preview?.loading, true)
  })

  it('file content is handled as plain text data', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    const start = { ...initialExplorerState(), workspaceId: 4 }
    const loaded = explorerReducer(
      explorerReducer(start, { type: 'file-selected', path: 'evil.html' }),
      { type: 'file-loaded', workspaceId: 4, path: 'evil.html', content: hostile, revision: 'c'.repeat(64) }
    )
    assert.equal(loaded.preview?.content, hostile)
    assert.equal(typeof loaded.preview?.content, 'string')
  })
})
