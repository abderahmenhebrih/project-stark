import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Static bridge contract: the preload source must expose exactly the
 * fixed per-domain functions and must never gain raw capabilities.
 * Runs against the repository source (cwd is the repo root via npm).
 */
function readPreloadSource(): string {
  const file = join(process.cwd(), 'src', 'preload', 'index.ts')
  assert.ok(existsSync(file), 'preload source must exist')
  return readFileSync(file, 'utf8')
}

describe('preload contract', () => {
  it('exposes the fixed stark bridge with app, settings, profile, and workspace domains', () => {
    const source = readPreloadSource()
    for (const expected of [
      'contextBridge.exposeInMainWorld',
      "'stark'",
      'getAppInfo',
      'settings',
      'profile',
      'workspace',
      'getCurrent',
      'listRecent',
      'chooseDirectory',
      'files',
      'listDirectory',
      'readTextFile',
      'writeTextFile',
      'search',
      'changes',
      'listRecent',
      'accept',
      'reject',
      'rollback',
      'IPC_CHANNELS'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
  })

  it('changes add only the intended transaction methods', () => {
    const source = readPreloadSource()
    for (const expected of [
      'IPC_CHANNELS.changesCreate',
      'IPC_CHANNELS.changesGet',
      'IPC_CHANNELS.changesListRecent',
      'IPC_CHANNELS.changesAccept',
      'IPC_CHANNELS.changesReject',
      'IPC_CHANNELS.changesRollback'
    ]) {
      assert.ok(source.includes(expected), `preload must contain ${expected}`)
    }
    for (const forbidden of [
      'transaction:execute',
      'db:',
      'sql:',
      'repository',
      'Repository',
      'sqlite',
      'saveAs',
      'createFile',
      'deleteFile',
      'forceApply',
      'forceRollback'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('write adds only the intended save method', () => {
    const source = readPreloadSource()
    assert.ok(source.includes('IPC_CHANNELS.workspaceFilesWriteTextFile'))
    assert.ok(source.includes('writeTextFile'))
    for (const forbidden of ['save-as', 'saveAs', 'createFile', 'deleteFile', 'moveFile', 'copyFile']) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('search adds only the intended method', () => {
    const source = readPreloadSource()
    assert.ok(source.includes('workspaceSearch') || source.includes('workspaceSearchResult') || source.includes('search'))
    assert.ok(source.includes('IPC_CHANNELS.workspaceSearch'))
    for (const forbidden of ['fs:', 'search:any-path', 'grep', 'ripgrep']) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })

  it('uses no raw channel strings', () => {
    const source = readPreloadSource()
    assert.ok(!source.includes("'stark:"), 'preload must not hardcode channel names')
  })

  it('exposes no raw capabilities', () => {
    const source = readPreloadSource()
    for (const forbidden of [
      'require(',
      'DatabaseSync',
      'KeyValueRepository',
      'WorkspaceRepository',
      'SettingsService',
      'WorkspaceService',
      'WorkspaceSearchService',
      'key_value',
      'workspaces',
      'SELECT',
      'INSERT',
      'DELETE',
      'UPDATE',
      'node:sqlite',
      'node:fs',
      'node:path',
      'shell',
      'dialog',
      'showOpenDialog',
      'realpath',
      'readDir',
      'readdir',
      'readFile',
      'writeFile',
      'rename',
      'unlink',
      'chmod',
      'open(',
      'crypto',
      'lstat',
      'stat(',
      'send(',
      'child_process',
      'spawn',
      'exec',
      'ripgrep',
      'glob',
      'regex'
    ]) {
      assert.ok(!source.includes(forbidden), `preload must not contain ${forbidden}`)
    }
  })
})
