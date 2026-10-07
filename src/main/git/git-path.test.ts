import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateGitRelativePath } from './git-path'

describe('git path validation', () => {
  it('rejects empty path', () => {
    assert.throws(() => validateGitRelativePath(''))
    assert.throws(() => validateGitRelativePath('.'))
  })

  it('rejects .. and nested traversal', () => {
    assert.throws(() => validateGitRelativePath('..'))
    assert.throws(() => validateGitRelativePath('../escape.txt'))
    assert.throws(() => validateGitRelativePath('a/../../b.txt'))
    assert.throws(() => validateGitRelativePath('a/../b.txt'))
  })

  it('rejects absolute POSIX path', () => {
    assert.throws(() => validateGitRelativePath('/etc/passwd'))
  })

  it('rejects absolute Windows path', () => {
    assert.throws(() => validateGitRelativePath('C:\\Windows\\file.txt'))
    assert.throws(() => validateGitRelativePath('C:/Windows/file.txt'))
  })

  it('rejects drive path', () => {
    assert.throws(() => validateGitRelativePath('D:file.txt'))
  })

  it('rejects UNC', () => {
    assert.throws(() => validateGitRelativePath('\\\\server\\share\\file.txt'))
    assert.throws(() => validateGitRelativePath('//server/share/file.txt'))
  })

  it('rejects NUL', () => {
    assert.throws(() => validateGitRelativePath('bad\0file.txt'))
  })

  it('rejects overlong path', () => {
    assert.throws(() => validateGitRelativePath(`${'a'.repeat(4097)}.txt`))
  })

  it('rejects non-strings', () => {
    assert.throws(() => validateGitRelativePath(null))
    assert.throws(() => validateGitRelativePath(42))
    assert.throws(() => validateGitRelativePath(undefined))
  })

  it('accepts nested/file.ts', () => {
    assert.equal(validateGitRelativePath('nested/file.ts'), 'nested/file.ts')
  })

  it('accepts Unicode path', () => {
    assert.equal(validateGitRelativePath('caf\u00e9/\u65e5\u672c\u8a9e.txt'), 'caf\u00e9/\u65e5\u672c\u8a9e.txt')
  })

  it('accepts spaces', () => {
    assert.equal(validateGitRelativePath('my docs/file name.txt'), 'my docs/file name.txt')
  })

  it('accepts deleted-path syntax without existence check', () => {
    assert.equal(validateGitRelativePath('gone/deleted.ts'), 'gone/deleted.ts')
  })

  it('normalizes backslashes for comparison', () => {
    assert.equal(validateGitRelativePath('a\\b\\c.ts'), 'a/b/c.ts')
  })
})
