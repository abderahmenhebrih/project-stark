import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { Workspace } from '../../shared/workspace/types'
import {
  InvalidWorkspaceError,
  WorkspaceNotFoundError
} from '../workspace/errors'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from './errors'
import { MAX_DIRECTORY_ENTRIES, MAX_TEXT_FILE_BYTES } from './limits'
import { WorkspaceFilesService } from './workspace-files-service'

interface Fixture {
  db: DatabaseSync
  service: WorkspaceFilesService
  root: string
  dir: string
  workspace: Workspace
  links: { outside: boolean; inside: boolean; file: boolean }
}

function tryLink(target: string, linkPath: string, type: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, linkPath, type)
    return true
  } catch {
    return false
  }
}

function openFixture(): Fixture {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const repository = new WorkspaceRepository(db)
  const service = new WorkspaceFilesService(repository)
  const dir = mkdtempSync(join(tmpdir(), 'stark-wsfs-'))
  const root = join(dir, 'project')
  const write = (rel: string, content: string | Buffer): void => {
    writeFileSync(join(root, rel), content)
  }
  const mkdir = (rel: string): void => {
    mkdirSync(join(root, rel), { recursive: true })
  }
  mkdir('src')
  mkdir('src/nested')
  mkdir('sub600')
  mkdir('.git')
  mkdir('node_modules')
  mkdir('dist')
  mkdir('uni-dir-tést')
  write('src/main.ts', "export const x = 1\n")
  write('src/nested/deep.txt', 'deep\n')
  write('README.md', '# Test\n')
  write('package.json', '{"name":"t"}\n')
  write('.gitignore', 'out/\n')
  write('.git/HEAD', 'ref: refs/heads/main\n')
  write('node_modules/pkg.js', 'x\n')
  write('dist/out.js', 'y\n')
  write('empty.txt', '')
  write('crlf.txt', 'a\r\nb\nc')
  write('uni.txt', 'héllo wörld ✓\n')
  write('uni-dir-tést/ünï.txt', 'unicode names\n')
  write('evil.html', '<script>alert(1)</script>\n')
  write('exact.bin', Buffer.alloc(MAX_TEXT_FILE_BYTES, 'a'))
  write('over.bin', Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 'b'))
  write('nul.bin', Buffer.from([0x68, 0x69, 0x00, 0x21]))
  write('badutf8.txt', Buffer.from([0x66, 0xff, 0x66]))
  for (let i = 0; i < 600; i += 1) {
    write(`sub600/f-${String(i).padStart(3, '0')}.txt`, 'x\n')
  }
  const outside = join(dir, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'shh\n')
  const links = {
    outside: tryLink(outside, join(root, 'link-out'), 'junction'),
    inside: tryLink(join(root, 'src'), join(root, 'link-in'), 'junction'),
    file: tryLink(join(outside, 'secret.txt'), join(root, 'link-file'), 'file')
  }
  const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
  return { db, service, root, dir, workspace, links }
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function request(workspaceId: number, relativePath: string): unknown {
  return { workspaceId, relativePath }
}

describe('directory listing', () => {
  it('lists the root with sorted entries', async () => {
    const fixture = openFixture()
    try {
      const listing = await fixture.service.listDirectory(request(fixture.workspace.id, ''))
      assert.equal(listing.workspaceId, fixture.workspace.id)
      assert.equal(listing.relativePath, '')
      assert.equal(listing.truncated, false)
      const kinds = listing.entries.map((entry) => entry.kind)
      const dirs = listing.entries.filter((entry) => entry.kind === 'directory').map((e) => e.name)
      assert.ok(dirs.includes('src'))
      assert.ok(dirs.includes('sub600'))
      assert.ok(!dirs.includes('.git'))
      assert.ok(!dirs.includes('node_modules'))
      assert.ok(!dirs.includes('dist'))
      const names = listing.entries.map((entry) => entry.name)
      assert.ok(names.includes('.gitignore'))
      assert.ok(names.includes('package.json'))
      const ranks = kinds.map((kind) =>
        kind === 'directory' ? 0 : kind === 'file' ? 1 : kind === 'symlink' ? 2 : 3
      )
      for (let i = 1; i < ranks.length; i += 1) {
        assert.ok(ranks[i] >= ranks[i - 1])
      }
    } finally {
      closeFixture(fixture)
    }
  })

  it('lists nested directories on demand only', async () => {
    const fixture = openFixture()
    try {
      const listing = await fixture.service.listDirectory(request(fixture.workspace.id, 'src'))
      assert.equal(listing.relativePath, 'src')
      assert.deepEqual(
        listing.entries.map((entry) => entry.name),
        ['nested', 'main.ts']
      )
      assert.equal(listing.entries[0]?.kind, 'directory')
      assert.equal(listing.entries[1]?.kind, 'file')
    } finally {
      closeFixture(fixture)
    }
  })

  it('reports file sizes and symlink kinds', async () => {
    const fixture = openFixture()
    try {
      const listing = await fixture.service.listDirectory(request(fixture.workspace.id, ''))
      const readme = listing.entries.find((entry) => entry.name === 'README.md')
      assert.ok(readme !== undefined && readme.size === 7)
      const empty = listing.entries.find((entry) => entry.name === 'empty.txt')
      assert.ok(empty !== undefined && empty.size === 0)
      const src = listing.entries.find((entry) => entry.name === 'src')
      assert.ok(src !== undefined && src.size === null)
      if (fixture.links.outside) {
        const link = listing.entries.find((entry) => entry.name === 'link-out')
        assert.ok(link !== undefined && link.kind === 'symlink' && link.size === null)
      } else {
        console.warn('skipped: symlink listing case needs link privileges')
      }
    } finally {
      closeFixture(fixture)
    }
  })

  it('caps huge directories with truncation', async () => {
    const fixture = openFixture()
    try {
      const listing = await fixture.service.listDirectory(request(fixture.workspace.id, 'sub600'))
      assert.equal(listing.entries.length, MAX_DIRECTORY_ENTRIES)
      assert.equal(listing.truncated, true)
      assert.equal(listing.entries[0]?.name, 'f-000.txt')
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects unknown workspaces, missing roots, and missing directories', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.listDirectory(request(fixture.workspace.id + 999, '')),
        WorkspaceNotFoundError
      )
      await assert.rejects(
        fixture.service.listDirectory(request(fixture.workspace.id, 'nope')),
        WorkspacePathNotFoundError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects files and symlinks as list targets', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.listDirectory(request(fixture.workspace.id, 'package.json')),
        WorkspaceEntryTypeError
      )
      if (fixture.links.outside) {
        // The segment walk refuses the link itself before containment is consulted.
        await assert.rejects(
          fixture.service.listDirectory(request(fixture.workspace.id, 'link-out')),
          WorkspaceEntryTypeError
        )
      } else {
        console.warn('skipped: symlink list-target case needs link privileges')
      }
      if (fixture.links.inside) {
        // Inside-pointing links resolve safely but are still never traversed.
        await assert.rejects(
          fixture.service.listDirectory(request(fixture.workspace.id, 'link-in')),
          WorkspaceEntryTypeError
        )
      } else {
        console.warn('skipped: inner-link list-target case needs link privileges')
      }
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects traversal and invalid payloads', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.listDirectory(request(fixture.workspace.id, '..')),
        WorkspacePathOutsideRootError
      )
      await assert.rejects(
        fixture.service.listDirectory(request(fixture.workspace.id, '/abs')),
        InvalidWorkspaceError
      )
      await assert.rejects(fixture.service.listDirectory({ workspaceId: 'x' }), InvalidWorkspaceError)
      await assert.rejects(fixture.service.listDirectory(null), InvalidWorkspaceError)
    } finally {
      closeFixture(fixture)
    }
  })

  it('keeps unicode filenames intact', async () => {
    const fixture = openFixture()
    try {
      const listing = await fixture.service.listDirectory(request(fixture.workspace.id, 'uni-dir-tést'))
      assert.deepEqual(
        listing.entries.map((entry) => entry.name),
        ['ünï.txt']
      )
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('text file reading', () => {
  it('reads small UTF-8 files exactly', async () => {
    const fixture = openFixture()
    try {
      const file = await fixture.service.readTextFile(request(fixture.workspace.id, 'src/main.ts'))
      assert.equal(file.workspaceId, fixture.workspace.id)
      assert.equal(file.relativePath, 'src/main.ts')
      assert.equal(file.content, 'export const x = 1\n')
      assert.equal(file.size, 19)
    } finally {
      closeFixture(fixture)
    }
  })

  it('preserves unicode, line endings, and empty files', async () => {
    const fixture = openFixture()
    try {
      const uni = await fixture.service.readTextFile(request(fixture.workspace.id, 'uni.txt'))
      assert.equal(uni.content, 'héllo wörld ✓\n')
      const crlf = await fixture.service.readTextFile(request(fixture.workspace.id, 'crlf.txt'))
      assert.equal(crlf.content, 'a\r\nb\nc')
      const empty = await fixture.service.readTextFile(request(fixture.workspace.id, 'empty.txt'))
      assert.equal(empty.content, '')
      assert.equal(empty.size, 0)
    } finally {
      closeFixture(fixture)
    }
  })

  it('returns markup literally without executing it', async () => {
    const fixture = openFixture()
    try {
      const file = await fixture.service.readTextFile(request(fixture.workspace.id, 'evil.html'))
      assert.ok(file.content.includes('<script>alert(1)</script>'))
    } finally {
      closeFixture(fixture)
    }
  })

  it('accepts the exact size limit and rejects beyond it', async () => {
    const fixture = openFixture()
    try {
      const exact = await fixture.service.readTextFile(request(fixture.workspace.id, 'exact.bin'))
      assert.equal(exact.size, MAX_TEXT_FILE_BYTES)
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, 'over.bin')),
        FileTooLargeError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects NUL bytes and invalid UTF-8', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, 'nul.bin')),
        UnsupportedFileError
      )
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, 'badutf8.txt')),
        UnsupportedFileError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects directories, symlinks, and missing files', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, 'src')),
        WorkspaceEntryTypeError
      )
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, 'missing.txt')),
        WorkspacePathNotFoundError
      )
      await assert.rejects(
        fixture.service.readTextFile(request(fixture.workspace.id, '../evil')),
        WorkspacePathOutsideRootError
      )
      if (fixture.links.file) {
        await assert.rejects(
          fixture.service.readTextFile(request(fixture.workspace.id, 'link-file')),
          WorkspaceEntryTypeError
        )
      } else {
        console.warn('skipped: file-symlink read case needs link privileges')
      }
    } finally {
      closeFixture(fixture)
    }
  })
})
