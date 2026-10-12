import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  explorerBasename,
  explorerParentOf,
  validateExplorerDraftName
} from './explorer-crud-state'

describe('explorer CRUD path helpers', () => {
  it('splits basenames and parents with root semantics', () => {
    assert.equal(explorerBasename(''), '')
    assert.equal(explorerBasename('notes.txt'), 'notes.txt')
    assert.equal(explorerBasename('src/app.ts'), 'app.ts')
    assert.equal(explorerBasename('a/b/c'), 'c')
    assert.equal(explorerParentOf(''), '')
    assert.equal(explorerParentOf('notes.txt'), '')
    assert.equal(explorerParentOf('src/app.ts'), 'src')
    assert.equal(explorerParentOf('a/b/c'), 'a/b')
  })

  it('gives instant draft feedback (main stays authoritative)', () => {
    assert.equal(validateExplorerDraftName('index.ts'), null)
    assert.equal(validateExplorerDraftName('  app.ts  '), null)
    assert.equal(validateExplorerDraftName(''), 'Enter a name.')
    assert.equal(validateExplorerDraftName('   '), 'Enter a name.')
    assert.equal(validateExplorerDraftName('a/b'), 'Use a plain name without path separators.')
    assert.equal(validateExplorerDraftName('a\\b'), 'Use a plain name without path separators.')
    assert.equal(validateExplorerDraftName('.'), 'That name isn’t valid.')
    assert.equal(validateExplorerDraftName('..'), 'That name isn’t valid.')
    assert.equal(validateExplorerDraftName('a'.repeat(256)), 'That name is too long.')
  })
})
