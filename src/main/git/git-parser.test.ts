import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildBranchInfo,
  parseAheadBehind,
  parseHeadShort,
  parsePorcelainV1Z,
  parseSymbolicRef,
  parseUpstream
} from './git-parser'

function nul(...parts: string[]): Buffer {
  return Buffer.from(parts.join('\0') + '\0', 'utf8')
}

describe('git status parser (porcelain v1 -z)', () => {
  it('parses clean output', () => {
    assert.deepEqual(parsePorcelainV1Z(Buffer.from('', 'utf8')), [])
    assert.deepEqual(parsePorcelainV1Z(''), [])
  })

  it('parses modified unstaged', () => {
    const files = parsePorcelainV1Z(nul(' M src/app.ts'))
    assert.equal(files.length, 1)
    assert.equal(files[0]?.relativePath, 'src/app.ts')
    assert.equal(files[0]?.originalPath, null)
    assert.equal(files[0]?.indexStatus, ' ')
    assert.equal(files[0]?.worktreeStatus, 'M')
    assert.equal(files[0]?.staged, false)
    assert.equal(files[0]?.unstaged, true)
    assert.equal(files[0]?.untracked, false)
    assert.equal(files[0]?.conflicted, false)
  })

  it('parses modified staged', () => {
    const files = parsePorcelainV1Z(nul('M  src/app.ts'))
    assert.equal(files[0]?.staged, true)
    assert.equal(files[0]?.unstaged, false)
  })

  it('parses staged + unstaged same file', () => {
    const files = parsePorcelainV1Z(nul('MM src/app.ts'))
    assert.equal(files[0]?.staged, true)
    assert.equal(files[0]?.unstaged, true)
  })

  it('parses added', () => {
    const files = parsePorcelainV1Z(nul('A  new-file.txt'))
    assert.equal(files[0]?.staged, true)
    assert.equal(files[0]?.indexStatus, 'A')
  })

  it('parses deleted (staged and unstaged)', () => {
    const staged = parsePorcelainV1Z(nul('D  gone.ts'))
    assert.equal(staged[0]?.staged, true)
    const working = parsePorcelainV1Z(nul(' D gone.ts'))
    assert.equal(working[0]?.unstaged, true)
  })

  it('parses renamed with NUL record structure', () => {
    // -z rename order is reversed: new path first, old path second.
    const raw = Buffer.from('R  new/name.ts\0old/name.ts\0', 'utf8')
    const files = parsePorcelainV1Z(raw)
    assert.equal(files.length, 1)
    assert.equal(files[0]?.relativePath, 'new/name.ts')
    assert.equal(files[0]?.originalPath, 'old/name.ts')
    assert.equal(files[0]?.staged, true)
  })

  it('parses copied where emitted', () => {
    const raw = Buffer.from('C  copy/to.ts\0copy/from.ts\0', 'utf8')
    const files = parsePorcelainV1Z(raw)
    assert.equal(files.length, 1)
    assert.equal(files[0]?.relativePath, 'copy/to.ts')
    assert.equal(files[0]?.originalPath, 'copy/from.ts')
  })

  it('parses type-changed', () => {
    const files = parsePorcelainV1Z(nul('T  link-or-mode.ts'))
    assert.equal(files[0]?.indexStatus, 'T')
    assert.equal(files[0]?.staged, true)
  })

  it('parses untracked', () => {
    const files = parsePorcelainV1Z(nul('?? scratch/notes.txt'))
    assert.equal(files[0]?.untracked, true)
    assert.equal(files[0]?.staged, false)
    assert.equal(files[0]?.unstaged, false)
    assert.equal(files[0]?.conflicted, false)
  })

  it('parses conflict combinations', () => {
    for (const pair of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const files = parsePorcelainV1Z(nul(`${pair} conflicted.txt`))
      assert.equal(files[0]?.conflicted, true, pair)
      assert.equal(files[0]?.staged, false, pair)
      assert.equal(files[0]?.unstaged, false, pair)
      assert.equal(files[0]?.untracked, false, pair)
    }
  })

  it('handles filenames with spaces', () => {
    const files = parsePorcelainV1Z(nul(' M my docs/file name.txt'))
    assert.equal(files[0]?.relativePath, 'my docs/file name.txt')
  })

  it('handles Unicode filenames', () => {
    const files = parsePorcelainV1Z(nul('?? caf\u00e9/\u65e5\u672c\u8a9e.txt'))
    assert.equal(files[0]?.relativePath, 'caf\u00e9/\u65e5\u672c\u8a9e.txt')
    assert.equal(files[0]?.untracked, true)
  })

  it('handles NUL-separated multiple records', () => {
    const raw = Buffer.from('M  a.ts\0 M b.ts\0?? c.ts\0', 'utf8')
    const files = parsePorcelainV1Z(raw)
    assert.equal(files.length, 3)
    assert.equal(files[0]?.relativePath, 'a.ts')
    assert.equal(files[1]?.relativePath, 'b.ts')
    assert.equal(files[2]?.relativePath, 'c.ts')
  })

  it('fails safely on malformed records', () => {
    assert.throws(() => parsePorcelainV1Z(Buffer.from('M', 'utf8')))
    assert.throws(() => parsePorcelainV1Z(Buffer.from('MXX', 'utf8')))
    assert.throws(() => parsePorcelainV1Z(Buffer.from('R  only-new.ts\0', 'utf8')))
    assert.throws(() => parsePorcelainV1Z(Buffer.from('Q  weird.ts\0', 'utf8')))
  })
})

describe('git branch parsing', () => {
  it('parses normal branch', () => {
    assert.equal(parseSymbolicRef(0, 'main\n'), 'main')
    assert.equal(parseSymbolicRef(0, 'feature/x\n'), 'feature/x')
  })

  it('parses detached (symbolic fails, head resolves)', () => {
    assert.equal(parseSymbolicRef(1, ''), null)
    assert.equal(parseHeadShort(0, 'abc123def456\n'), 'abc123def456')
  })

  it('parses unborn (both fail)', () => {
    assert.equal(parseSymbolicRef(128, ''), null)
    assert.equal(parseHeadShort(128, ''), null)
    const info = buildBranchInfo({ symbolicName: null, headShort: null, upstream: null, aheadBehind: null })
    assert.equal(info.kind, 'unborn')
    assert.equal(info.name, null)
    assert.equal(info.head, null)
  })

  it('parses upstream and no-upstream', () => {
    assert.equal(parseUpstream(0, 'origin/main\n'), 'origin/main')
    assert.equal(parseUpstream(1, ''), null)
    assert.equal(parseUpstream(128, ''), null)
  })

  it('parses ahead/behind counts', () => {
    assert.deepEqual(parseAheadBehind('2\t1\n'), { ahead: 2, behind: 1 })
    assert.deepEqual(parseAheadBehind('0\t0\n'), { ahead: 0, behind: 0 })
    assert.deepEqual(parseAheadBehind('10  3\n'), { ahead: 10, behind: 3 })
  })

  it('parses ahead+behind combined', () => {
    const info = buildBranchInfo({
      symbolicName: 'main',
      headShort: 'abc123def456',
      upstream: 'origin/main',
      aheadBehind: { ahead: 2, behind: 1 }
    })
    assert.equal(info.kind, 'branch')
    assert.equal(info.ahead, 2)
    assert.equal(info.behind, 1)
  })

  it('fails safely on malformed counts', () => {
    assert.throws(() => parseAheadBehind(''))
    assert.throws(() => parseAheadBehind('abc'))
    assert.throws(() => parseAheadBehind('1'))
    assert.throws(() => parseAheadBehind('1.5\t2'))
    assert.throws(() => parseAheadBehind('-1\t2'))
  })

  it('fails safely on malformed branch output', () => {
    assert.throws(() => parseSymbolicRef(0, ''))
    assert.throws(() => parseHeadShort(0, 'not a hash!!'))
    assert.throws(() => parseUpstream(0, ''))
  })

  it('builds detached info', () => {
    const info = buildBranchInfo({ symbolicName: null, headShort: 'abc123', upstream: null, aheadBehind: null })
    assert.equal(info.kind, 'detached')
    assert.equal(info.head, 'abc123')
  })
})
