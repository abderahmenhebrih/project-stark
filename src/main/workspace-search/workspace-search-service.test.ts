import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { Workspace } from '../../shared/workspace/types'
import { WorkspaceNotFoundError } from '../workspace/errors'
import { InvalidSearchQueryError } from './errors'
import {
  MAX_MATCHES_PER_FILE,
  MAX_PREVIEW_CHARACTERS,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULTS,
  MAX_TOTAL_SEARCH_BYTES
} from './limits'
import { WorkspaceSearchService } from './workspace-search-service'

const LF = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

interface Fixture {
  db: DatabaseSync
  service: WorkspaceSearchService
  root: string
  dir: string
  workspace: Workspace
}

function openDatabase(): { db: DatabaseSync; repository: WorkspaceRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, repository: new WorkspaceRepository(db) }
}

function makeWorkspace(files: Record<string, string | Buffer>): Fixture {
  const { db, repository } = openDatabase()
  const service = new WorkspaceSearchService(repository)
  const dir = mkdtempSync(join(tmpdir(), 'stark-wsearch-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const parts = relative.split('/')
    const fileName = parts.pop() as string
    const parent = join(root, ...parts)
    mkdirSync(parent, { recursive: true })
    void fileName
    writeFileSync(join(root, ...relative.split('/')), content)
  }
  const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
  return { db, service, root, dir, workspace }
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function tryLink(target: string, linkPath: string, type: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, linkPath, type)
    return true
  } catch {
    return false
  }
}

describe('workspace search service', () => {
  it('finds a root-level match with line, column, and preview', async () => {
    const fixture = makeWorkspace({ 'README.md': 'hello authentication world' + LF })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.workspaceId, fixture.workspace.id)
      assert.equal(result.query, 'authentication')
      assert.equal(result.matches.length, 1)
      assert.equal(result.matches[0]?.relativePath, 'README.md')
      assert.equal(result.matches[0]?.line, 1)
      assert.equal(result.matches[0]?.column, 7)
      assert.ok((result.matches[0]?.preview ?? '').includes('authentication'))
      assert.equal(result.filesScanned, 1)
      assert.equal(result.filesMatched, 1)
      assert.equal(result.truncated, false)
    } finally {
      closeFixture(fixture)
    }
  })

  it('finds nested-file matches across multiple files', async () => {
    const fixture = makeWorkspace({
      'src/auth/login.ts': 'const authenticationToken = 1' + LF,
      'src/services/session.ts': 'authentication failed' + LF,
      'other.txt': 'nothing here' + LF
    })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.matches.length, 2)
      assert.deepEqual(
        result.matches.map((m) => m.relativePath),
        ['src/auth/login.ts', 'src/services/session.ts']
      )
      assert.equal(result.filesMatched, 2)
    } finally {
      closeFixture(fixture)
    }
  })

  it('reports correct line numbers and multiple matches per file and per line', async () => {
    const content = ['first line', 'xx authentication yy', 'authentication auth authentication'].join(LF) + LF
    const fixture = makeWorkspace({ 'a.txt': content })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.matches.length, 3)
      assert.deepEqual(
        result.matches.map((m) => [m.line, m.column]),
        [
          [2, 4],
          [3, 1],
          [3, 21]
        ]
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('matches unicode content and queries', async () => {
    const fixture = makeWorkspace({ 'uni.txt': 'héllo wörld ✓ authentication ✓' + LF })
    try {
      const check = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'wörld' })
      assert.equal(check.matches.length, 1)
      const tick = await fixture.service.search({ workspaceId: fixture.workspace.id, query: '✓' })
      assert.equal(tick.matches.length, 2)
    } finally {
      closeFixture(fixture)
    }
  })

  it('is case-insensitive by default and case-sensitive on demand', async () => {
    const fixture = makeWorkspace({ 'a.txt': 'Authentication TOKEN' + LF })
    try {
      const insensitive = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(insensitive.matches.length, 1)
      const sensitiveMiss = await fixture.service.search({
        workspaceId: fixture.workspace.id,
        query: 'authentication',
        caseSensitive: true
      })
      assert.equal(sensitiveMiss.matches.length, 0)
      const sensitiveHit = await fixture.service.search({
        workspaceId: fixture.workspace.id,
        query: 'Authentication',
        caseSensitive: true
      })
      assert.equal(sensitiveHit.matches.length, 1)
    } finally {
      closeFixture(fixture)
    }
  })

  it('treats regex punctuation literally', async () => {
    const fixture = makeWorkspace({
      'plain.txt': 'abc def' + LF,
      'special.txt': 'price .* [x] (calc) ' + BACKSLASH + ' end' + LF
    })
    try {
      const star = await fixture.service.search({ workspaceId: fixture.workspace.id, query: '.*' })
      assert.equal(star.matches.length, 1)
      assert.equal(star.matches[0]?.relativePath, 'special.txt')
      const bracket = await fixture.service.search({ workspaceId: fixture.workspace.id, query: '[x]' })
      assert.equal(bracket.matches.length, 1)
      const paren = await fixture.service.search({ workspaceId: fixture.workspace.id, query: '(calc)' })
      assert.equal(paren.matches.length, 1)
      const slash = await fixture.service.search({ workspaceId: fixture.workspace.id, query: BACKSLASH })
      assert.equal(slash.matches.length, 1)
    } finally {
      closeFixture(fixture)
    }
  })

  it('skips generated directories but searches normal dotfiles', async () => {
    const fixture = makeWorkspace({
      'src/keep.txt': 'authentication here' + LF,
      '.git/HEAD': 'authentication hidden' + LF,
      'node_modules/pkg.js': 'authentication hidden' + LF,
      'dist/out.js': 'authentication hidden' + LF,
      '.gitignore': 'authentication visible' + LF
    })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      const paths = result.matches.map((m) => m.relativePath).sort()
      assert.deepEqual(paths, ['.gitignore', 'src/keep.txt'])
    } finally {
      closeFixture(fixture)
    }
  })

  it('skips likely secret-bearing files automatically', async () => {
    const fixture = makeWorkspace({
      '.env': 'authentication secret' + LF,
      '.env.local': 'authentication secret' + LF,
      'id.pem': 'authentication secret' + LF,
      'key.key': 'authentication secret' + LF,
      'credentials.json': 'authentication secret' + LF,
      'visible.txt': 'authentication visible' + LF
    })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.deepEqual(
        result.matches.map((m) => m.relativePath),
        ['visible.txt']
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('skips file and directory symlinks without traversing', async () => {
    const { db, repository } = openDatabase()
    const service = new WorkspaceSearchService(repository)
    const dir = mkdtempSync(join(tmpdir(), 'stark-wsearch-link-'))
    const root = join(dir, 'project')
    mkdirSync(join(root, 'real'), { recursive: true })
    writeFileSync(join(root, 'real', 'inner.txt'), 'authentication inner' + LF)
    writeFileSync(join(root, 'top.txt'), 'authentication top' + LF)
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'authentication outside' + LF)
    const fileLink = tryLink(join(outside, 'secret.txt'), join(root, 'link-file.txt'), 'file')
    const dirLink = tryLink(join(root, 'real'), join(root, 'link-dir'), 'junction')
    const outsideLink = tryLink(outside, join(root, 'link-out'), 'junction')
    const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
    try {
      const result = await service.search({ workspaceId: workspace.id, query: 'authentication' })
      const paths = result.matches.map((m) => m.relativePath).sort()
      assert.ok(paths.includes('real/inner.txt'))
      assert.ok(paths.includes('top.txt'))
      assert.ok(!paths.some((p) => p.includes('link-')))
      assert.ok(!paths.some((p) => p.includes('secret.txt')))
      if (!fileLink) {
        console.warn('skipped: file-symlink case needs link privileges')
      }
      if (!dirLink || !outsideLink) {
        console.warn('skipped: dir-symlink traversal case needs link privileges')
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips invalid UTF-8 and NUL-containing binary files', async () => {
    const fixture = makeWorkspace({
      'good.txt': 'authentication good' + LF,
      'bad.txt': Buffer.from([0x66, 0xff, 0x66]),
      'nul.bin': Buffer.from([0x68, 0x69, 0x00, 0x21])
    })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.deepEqual(
        result.matches.map((m) => m.relativePath),
        ['good.txt']
      )
      assert.equal(result.filesScanned, 3)
      assert.equal(result.filesMatched, 1)
    } finally {
      closeFixture(fixture)
    }
  })

  it('skips files larger than 1 MiB without failing the search', async () => {
    const fixture = makeWorkspace({
      'small.txt': 'authentication small' + LF,
      'big.bin': Buffer.alloc(MAX_SEARCH_FILE_BYTES + 1, 'b')
    })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.deepEqual(
        result.matches.map((m) => m.relativePath),
        ['small.txt']
      )
      assert.equal(result.truncated, false)
    } finally {
      closeFixture(fixture)
    }
  })

  it('caps results at 200 matches with truncation', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 210; i += 1) {
      const name = 'f-' + String(i).padStart(3, '0') + '.txt'
      files[name] = 'authentication ' + String(i) + LF
    }
    const fixture = makeWorkspace(files)
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.matches.length, MAX_SEARCH_RESULTS)
      assert.equal(result.truncated, true)
      assert.ok(result.matches.every((m) => m.relativePath.length > 0 && !m.relativePath.includes(':')))
    } finally {
      closeFixture(fixture)
    }
  })

  it('caps matches at 20 per file without global truncation', async () => {
    const lines: string[] = []
    for (let i = 0; i < 30; i += 1) {
      lines.push('authentication ' + String(i))
    }
    const fixture = makeWorkspace({ 'many.txt': lines.join(LF) + LF })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.matches.length, MAX_MATCHES_PER_FILE)
      assert.equal(result.truncated, false)
      assert.equal(result.filesMatched, 1)
    } finally {
      closeFixture(fixture)
    }
  })

  it('caps scanned files at 2000 with truncation', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_SEARCH_FILES + 5; i += 1) {
      files['n-' + String(i).padStart(4, '0') + '.txt'] = 'nothing to see here ' + String(i) + LF
    }
    const fixture = makeWorkspace(files)
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication-missing-xyz' })
      assert.equal(result.matches.length, 0)
      assert.equal(result.filesScanned, MAX_SEARCH_FILES)
      assert.equal(result.truncated, true)
    } finally {
      closeFixture(fixture)
    }
  })

  it('respects the total byte budget with truncation', async () => {
    const files: Record<string, Buffer> = {}
    const oneMiB = 1024 * 1024
    const count = Math.floor(MAX_TOTAL_SEARCH_BYTES / oneMiB) + 1
    for (let i = 0; i < count; i += 1) {
      files['b-' + String(i).padStart(2, '0') + '.bin'] = Buffer.alloc(oneMiB, 'x')
    }
    const fixture = makeWorkspace(files)
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication-missing-xyz' })
      assert.equal(result.truncated, true)
      assert.ok(result.filesScanned < count)
      assert.ok(result.filesScanned * oneMiB <= MAX_TOTAL_SEARCH_BYTES)
    } finally {
      closeFixture(fixture)
    }
  })

  it('stops on the time budget with partial results and truncation', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 50; i += 1) {
      files['t-' + String(i).padStart(3, '0') + '.txt'] = 'authentication ' + String(i) + LF
    }
    const { db, repository } = openDatabase()
    let calls = 0
    const now = (): number => {
      calls += 1
      if (calls <= 3) {
        return 1000
      }
      return 1000 + 6000
    }
    const service = new WorkspaceSearchService(repository, { now })
    const dir = mkdtempSync(join(tmpdir(), 'stark-wsearch-time-'))
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    for (const [relative, content] of Object.entries(files)) {
      writeFileSync(join(root, relative), content)
    }
    const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
    try {
      const result = await service.search({ workspaceId: workspace.id, query: 'authentication' })
      assert.equal(result.truncated, true)
      assert.ok(result.matches.length >= 0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('orders results deterministically by path, line, then column', async () => {
    const fixture = makeWorkspace({
      'b.txt': 'authentication' + LF,
      'a.txt': ['authentication second', 'authentication first-line-second-match authentication'].join(LF) + LF
    })
    try {
      const first = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      const second = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.deepEqual(first.matches, second.matches)
      const paths = first.matches.map((m) => m.relativePath)
      const sorted = [...paths].sort()
      assert.deepEqual(paths, sorted)
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects unknown workspaces with a controlled error', async () => {
    const fixture = makeWorkspace({ 'a.txt': 'hello' + LF })
    try {
      await assert.rejects(
        fixture.service.search({ workspaceId: fixture.workspace.id + 999, query: 'hello' }),
        WorkspaceNotFoundError
      )
      await assert.rejects(fixture.service.search({ workspaceId: 'x', query: 'hello' }), Error)
      await assert.rejects(fixture.service.search({ workspaceId: 1, query: '' }), InvalidSearchQueryError)
    } finally {
      closeFixture(fixture)
    }
  })

  it('handles files disappearing mid-search without crashing', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i += 1) {
      files['d-' + String(i).padStart(3, '0') + '.txt'] = 'authentication ' + String(i) + LF
    }
    const { db, repository } = openDatabase()
    const service = new WorkspaceSearchService(repository)
    const dir = mkdtempSync(join(tmpdir(), 'stark-wsearch-vanish-'))
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    for (const [relative, content] of Object.entries(files)) {
      writeFileSync(join(root, relative), content)
    }
    const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
    try {
      const pending = service.search({ workspaceId: workspace.id, query: 'authentication' })
      rmSync(join(root, 'd-059.txt'), { force: true })
      rmSync(join(root, 'd-058.txt'), { force: true })
      const result = await pending
      assert.ok(result.matches.length > 0)
      assert.ok(!result.matches.some((m) => m.relativePath === 'd-059.txt' && result.filesScanned === 0))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never returns absolute paths and caps previews', async () => {
    const longLine = 'authentication ' + 'y'.repeat(500)
    const fixture = makeWorkspace({ 'sub/nested.txt': longLine + LF })
    try {
      const result = await fixture.service.search({ workspaceId: fixture.workspace.id, query: 'authentication' })
      assert.equal(result.matches.length, 1)
      const match = result.matches[0]
      assert.ok(match !== undefined)
      assert.ok(!match.relativePath.startsWith('/'))
      assert.ok(!match.relativePath.includes(':'))
      assert.ok(!match.relativePath.includes(String.fromCharCode(92)))
      assert.ok(match.line >= 1 && match.column >= 1)
      assert.ok(Array.from(match.preview).length <= MAX_PREVIEW_CHARACTERS)
      assert.ok(!match.preview.includes(String.fromCharCode(10)))
    } finally {
      closeFixture(fixture)
    }
  })
})
