import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { readStorageScope, storageDirName, writeStorageValue } from './extension-storage'

const EXT = 'dbaeumer.vscode-eslint@3.0.0'

describe('extension storage', () => {
  it('round-trips global and workspace scopes independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-storage-'))
    try {
      writeStorageValue(root, EXT, 'global', 'serverPid', 1234)
      writeStorageValue(root, EXT, 'workspace', 'serverPid', 5678)
      assert.equal(readStorageScope(root, EXT, 'global').get('serverPid'), 1234)
      assert.equal(readStorageScope(root, EXT, 'workspace').get('serverPid'), 5678)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes keys with undefined and isolates extensions', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-storage-del-'))
    try {
      writeStorageValue(root, EXT, 'global', 'temp', 'x')
      writeStorageValue(root, EXT, 'global', 'temp', undefined)
      assert.equal(readStorageScope(root, EXT, 'global').has('temp'), false)
      writeStorageValue(root, 'other.ext@1.0.0', 'global', 'temp', 'y')
      assert.equal(readStorageScope(root, EXT, 'global').has('temp'), false)
      assert.equal(readStorageScope(root, 'other.ext@1.0.0', 'global').get('temp'), 'y')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects non-primitive values and unsafe keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'stark-storage-bad-'))
    try {
      assert.throws(() => writeStorageValue(root, EXT, 'global', 'obj', { a: 1 }), /not valid/)
      assert.throws(() => writeStorageValue(root, EXT, 'global', '', 'x'), /not valid/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sanitizes directory names without traversal', () => {
    assert.equal(storageDirName(EXT), 'dbaeumer.vscode-eslint_3.0.0')
    assert.throws(() => storageDirName(''), /not valid/)
    assert.ok(!storageDirName('../../evil@1.0.0').includes('/'))
  })
})
