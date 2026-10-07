import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { Workspace } from '../../shared/workspace/types'
import { InvalidWorkspaceError } from '../workspace/errors'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspaceFileConflictError,
  WorkspaceFileWriteError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from './errors'
import { hashFileBytes } from './file-revision'
import { MAX_WRITABLE_TEXT_FILE_BYTES } from './limits'
import { WorkspaceFileWriteService, type WorkspaceFileWriteFileSystem } from './workspace-file-write-service'
import { WorkspaceFilesService } from './workspace-files-service'

const LF = String.fromCharCode(10)

interface Fixture {
  db: DatabaseSync
  writes: WorkspaceFileWriteService
  reads: WorkspaceFilesService
  root: string
  dir: string
  workspace: Workspace
  fileLinkCreated: boolean
}

function openFixture(system?: WorkspaceFileWriteFileSystem): Fixture {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const repository = new WorkspaceRepository(db)
  const writes = new WorkspaceFileWriteService(repository, system)
  const reads = new WorkspaceFilesService(repository)
  const dir = mkdtempSync(join(tmpdir(), 'stark-wsfilewrite-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'note.txt'), 'first line' + LF)
  writeFileSync(join(root, 'empty.txt'), '')
  writeFileSync(join(root, 'crlf.txt'), 'a' + String.fromCharCode(13, 10) + 'b' + LF + 'c')
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0x68, 0x69, 0x00, 0x21]))
  writeFileSync(join(root, 'over-limit.txt'), Buffer.alloc(MAX_WRITABLE_TEXT_FILE_BYTES + 1, 'z'))
  const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
  let fileLinkCreated: boolean
  try {
    symlinkSync(join(root, 'src', 'note.txt'), join(root, 'src', 'link-note.txt'), 'file')
    fileLinkCreated = true
  } catch {
    fileLinkCreated = false
  }
  return { db, writes, reads, root, dir, workspace, fileLinkCreated }
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function diskBytes(fixture: Fixture, rel: string): Buffer {
  return readFileSync(join(fixture.root, rel))
}

function assertNoTempFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    assert.ok(!entry.name.startsWith('.stark-tmp-'), `temp artifact leaked: ${entry.name}`)
    if (entry.isDirectory()) {
      assertNoTempFiles(join(dir, entry.name))
    }
  }
}

describe('write input validation', () => {
  it('accepts a valid string at exactly 1 MiB', async () => {
    const fixture = openFixture()
    try {
      writeFileSync(join(fixture.root, 'sized.txt'), 'a'.repeat(MAX_WRITABLE_TEXT_FILE_BYTES))
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'sized.txt' })
      const result = await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'sized.txt',
        expectedRevision: read.revision,
        content: 'b'.repeat(MAX_WRITABLE_TEXT_FILE_BYTES)
      })
      assert.equal(result.changed, true)
      assert.equal(result.size, MAX_WRITABLE_TEXT_FILE_BYTES)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects new content beyond 1 MiB', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: read.revision,
          content: 'b'.repeat(MAX_WRITABLE_TEXT_FILE_BYTES + 1)
        }),
        FileTooLargeError
      )
      assert.equal(diskBytes(fixture, 'src/note.txt').toString('utf8'), 'first line' + LF)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects NUL bytes in new content', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: read.revision,
          content: 'a' + String.fromCharCode(0) + 'b'
        }),
        UnsupportedFileError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects unpaired surrogates but accepts valid pairs', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const base = { workspaceId: fixture.workspace.id, relativePath: 'src/note.txt', expectedRevision: read.revision }
      await assert.rejects(
        fixture.writes.writeTextFile({ ...base, content: 'lone high ' + String.fromCharCode(0xd800) }),
        UnsupportedFileError
      )
      const afterHigh = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      await assert.rejects(
        fixture.writes.writeTextFile({ ...base, expectedRevision: afterHigh.revision, content: 'lone low ' + String.fromCharCode(0xdc00) }),
        UnsupportedFileError
      )
      const afterLow = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const pair = String.fromCharCode(0xd83d) + String.fromCharCode(0xde00)
      const result = await fixture.writes.writeTextFile({ ...base, expectedRevision: afterLow.revision, content: 'smile ' + pair + LF })
      assert.equal(result.changed, true)
      assert.equal(diskBytes(fixture, 'src/note.txt').toString('utf8'), 'smile ' + pair + LF)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects malformed revisions and invalid workspace ids', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      for (const badRevision of ['', 'xyz', read.revision.slice(0, 63), `${read.revision}0`, read.revision.toUpperCase(), 'g'.repeat(64), 42, null]) {
        await assert.rejects(
          fixture.writes.writeTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt', expectedRevision: badRevision, content: 'x' }),
          InvalidWorkspaceError
        )
      }
      for (const badId of [0, -1, 1.5, '1', null, Number.NaN]) {
        await assert.rejects(
          fixture.writes.writeTextFile({ workspaceId: badId, relativePath: 'src/note.txt', expectedRevision: read.revision, content: 'x' }),
          InvalidWorkspaceError
        )
      }
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects traversal, absolute, and NUL paths', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const base = { workspaceId: fixture.workspace.id, expectedRevision: read.revision, content: 'x' }
      await assert.rejects(fixture.writes.writeTextFile({ ...base, relativePath: '../evil.txt' }), WorkspacePathOutsideRootError)
      await assert.rejects(fixture.writes.writeTextFile({ ...base, relativePath: '/abs.txt' }), InvalidWorkspaceError)
      await assert.rejects(
        fixture.writes.writeTextFile({ ...base, relativePath: 'C:\\Windows\\Temp\\x.txt' }),
        InvalidWorkspaceError
      )
      await assert.rejects(
        fixture.writes.writeTextFile({ ...base, relativePath: 'a' + String.fromCharCode(0) + 'b.txt' }),
        InvalidWorkspaceError
      )
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('stale-safe write service', () => {
  it('updates an existing text file and returns the new revision', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const result = await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: read.revision,
        content: 'second line' + LF
      })
      assert.equal(result.workspaceId, fixture.workspace.id)
      assert.equal(result.relativePath, 'src/note.txt')
      assert.equal(result.changed, true)
      assert.equal(result.size, ('second line' + LF).length)
      const onDisk = diskBytes(fixture, 'src/note.txt')
      assert.equal(onDisk.toString('utf8'), 'second line' + LF)
      assert.equal(result.revision, createHash('sha256').update(onDisk).digest('hex'))
      assert.equal(result.revision, hashFileBytes(onDisk))
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('requires the correct expected revision', async () => {
    const fixture = openFixture()
    try {
      const other = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'empty.txt' })
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: other.revision,
          content: 'clobber' + LF
        }),
        WorkspaceFileConflictError
      )
      assert.equal(diskBytes(fixture, 'src/note.txt').toString('utf8'), 'first line' + LF)
    } finally {
      closeFixture(fixture)
    }
  })

  it('returns changed:false without replacing identical bytes', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const before = diskBytes(fixture, 'src/note.txt')
      const result = await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: read.revision,
        content: 'first line' + LF
      })
      assert.equal(result.changed, false)
      assert.equal(result.size, before.byteLength)
      assert.equal(result.revision, read.revision)
      assert.ok(diskBytes(fixture, 'src/note.txt').equals(before))
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses symlinks, missing files, directories, and non-regular targets', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const base = { workspaceId: fixture.workspace.id, expectedRevision: read.revision, content: 'x' + LF }
      if (fixture.fileLinkCreated) {
        await assert.rejects(
          fixture.writes.writeTextFile({ ...base, relativePath: 'src/link-note.txt' }),
          WorkspaceEntryTypeError
        )
      } else {
        console.warn('skipped: symlink write case needs link privileges')
      }
      await assert.rejects(
        fixture.writes.writeTextFile({ ...base, relativePath: 'missing.txt' }),
        WorkspacePathNotFoundError
      )
      await assert.rejects(fixture.writes.writeTextFile({ ...base, relativePath: 'src' }), WorkspaceEntryTypeError)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses binary and oversized originals', async () => {
    const fixture = openFixture()
    try {
      const revision = '0'.repeat(64)
      const base = { workspaceId: fixture.workspace.id, expectedRevision: revision, content: 'x' + LF }
      await assert.rejects(fixture.writes.writeTextFile({ ...base, relativePath: 'binary.dat' }), UnsupportedFileError)
      await assert.rejects(fixture.writes.writeTextFile({ ...base, relativePath: 'over-limit.txt' }), FileTooLargeError)
    } finally {
      closeFixture(fixture)
    }
  })

  it('preserves unicode and CRLF bytes exactly', async () => {
    const fixture = openFixture()
    try {
      const uni = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'empty.txt' })
      const unicodeContent = 'héllo wörld ✓' + LF + 'line2' + LF
      const uniResult = await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'empty.txt',
        expectedRevision: uni.revision,
        content: unicodeContent
      })
      assert.equal(uniResult.changed, true)
      assert.ok(diskBytes(fixture, 'empty.txt').equals(Buffer.from(unicodeContent, 'utf8')))

      const crlf = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'crlf.txt' })
      const crlfContent = 'x' + String.fromCharCode(13, 10) + 'y' + LF
      await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'crlf.txt',
        expectedRevision: crlf.revision,
        content: crlfContent
      })
      assert.ok(diskBytes(fixture, 'crlf.txt').equals(Buffer.from(crlfContent, 'utf8')))
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('preserves permission bits where the platform permits', async () => {
    const fixture = openFixture()
    try {
      if (process.platform === 'win32') {
        console.warn('skipped: POSIX mode preservation needs a POSIX platform')
        return
      }
      const target = join(fixture.root, 'src', 'note.txt')
      chmodSync(target, 0o755)
      const before = statSync(target).mode & 0o777
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      await fixture.writes.writeTextFile({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: read.revision,
        content: 'mode kept' + LF
      })
      assert.equal(statSync(target).mode & 0o777, before)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('never changes files outside the workspace', async () => {
    const fixture = openFixture()
    try {
      const outside = join(fixture.dir, 'outside.txt')
      writeFileSync(outside, 'outside' + LF)
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: '../outside.txt',
          expectedRevision: read.revision,
          content: 'pwned' + LF
        }),
        WorkspacePathOutsideRootError
      )
      assert.equal(readFileSync(outside, 'utf8'), 'outside' + LF)
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('critical external modification acceptance', () => {
  it('rejects a stale save and leaves external bytes untouched', async () => {
    const fixture = openFixture()
    try {
      // 1. STARK reads revision A.
      const readA = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const revisionA = readA.revision
      // 2. A draft is modified inside STARK (new content prepared).
      const draftContent = 'stark draft' + LF
      // 3. An external process changes the file to B.
      const externalContent = 'external change B' + LF
      writeFileSync(join(fixture.root, 'src', 'note.txt'), externalContent)
      const revisionB = hashFileBytes(Buffer.from(externalContent, 'utf8'))
      assert.notEqual(revisionB, revisionA)
      // 4. Save is submitted with the stale expected revision A.
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: revisionA,
          content: draftContent
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkspaceFileConflictError)
          // 5. The public copy tells the user to reload.
          assert.equal(error.message, 'This file changed on disk. Reload it before saving your changes.')
          return true
        }
      )
      // 6. External B remains byte-for-byte untouched.
      assert.ok(diskBytes(fixture, 'src/note.txt').equals(Buffer.from(externalContent, 'utf8')))
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('failure atomicity', () => {
  it('keeps the original intact and cleans temp when replacement fails', async () => {
    const failing: WorkspaceFileWriteFileSystem = {
      replaceFile: () => Promise.reject(new Error('injected rename failure'))
    }
    const fixture = openFixture(failing)
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      const before = diskBytes(fixture, 'src/note.txt')
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: read.revision,
          content: 'doomed write' + LF
        }),
        WorkspaceFileWriteError
      )
      assert.ok(diskBytes(fixture, 'src/note.txt').equals(before))
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })

  it('cleans temp after a controlled conflict failure', async () => {
    const fixture = openFixture()
    try {
      const read = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })
      // An external change lands after the read: the write must refuse
      // without leaving a temp artifact behind.
      writeFileSync(join(fixture.root, 'src', 'note.txt'), 'race winner' + LF)
      await assert.rejects(
        fixture.writes.writeTextFile({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: read.revision,
          content: 'race loser' + LF
        }),
        WorkspaceFileConflictError
      )
      assert.equal(diskBytes(fixture, 'src/note.txt').toString('utf8'), 'race winner' + LF)
      assertNoTempFiles(fixture.root)
    } finally {
      closeFixture(fixture)
    }
  })
})
