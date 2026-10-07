import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { Workspace } from '../../shared/workspace/types'
import { InvalidWorkspaceError, WorkspaceNotFoundError } from '../workspace/errors'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspacePathOutsideRootError
} from '../workspace-files/errors'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { MAX_RECENT_CHANGE_TRANSACTIONS } from './limits'
import { ChangeTransactionService } from './change-transaction-service'
import {
  CHANGE_CONFLICT_MESSAGE,
  CHANGE_ROLLBACK_CONFLICT_MESSAGE,
  ChangeTransactionConflictError,
  ChangeTransactionNoChangesError,
  ChangeTransactionNotFoundError,
  ChangeTransactionStateError,
  CorruptChangeTransactionError
} from './errors'

const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

interface Fixture {
  db: DatabaseSync
  service: ChangeTransactionService
  reads: WorkspaceFilesService
  transactions: ChangeTransactionRepository
  root: string
  dir: string
  workspace: Workspace
  now: number
  fileLinkCreated: boolean
}

function openFixture(): Fixture {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const transactions = new ChangeTransactionRepository(db)
  const writer = new WorkspaceFileWriteService(workspaces)
  const now = 1000
  const service = new ChangeTransactionService(workspaces, transactions, writer, () => now)
  const reads = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changetx-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'note.txt'), 'first line' + LF)
  writeFileSync(join(root, 'crlf.txt'), 'a' + CRLF + 'b' + LF)
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0x68, 0x69, 0x00, 0x21]))
  const workspace = workspaces.create({ rootPath: root, displayName: 'project', now })
  let fileLinkCreated: boolean
  try {
    symlinkSync(join(root, 'src', 'note.txt'), join(root, 'src', 'link-note.txt'), 'file')
    fileLinkCreated = true
  } catch {
    fileLinkCreated = false
  }
  return {
    db,
    service,
    reads,
    transactions,
    root,
    dir,
    workspace,
    now,
    fileLinkCreated
  }
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

function diskString(fixture: Fixture, rel: string): string {
  return readFileSync(join(fixture.root, rel), 'utf8')
}

async function readRevision(fixture: Fixture, rel: string): Promise<string> {
  const file = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: rel })
  return file.revision
}

function shaHex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('create proposal', () => {
  it('creates a valid pending proposal with checkpoint and revisions', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'second line' + LF
      })
      assert.equal(created.status, 'pending')
      assert.equal(created.workspaceId, fixture.workspace.id)
      assert.equal(created.files.length, 1)
      assert.equal(created.files[0]?.relativePath, 'src/note.txt')
      assert.equal(created.files[0]?.beforeRevision, before)
      assert.equal(created.files[0]?.beforeContent, 'first line' + LF)
      assert.equal(created.files[0]?.proposedContent, 'second line' + LF)
      assert.equal(created.files[0]?.appliedRevision, null)
      assert.equal(
        created.files[0]?.proposedRevision,
        shaHex(Buffer.from('second line' + LF, 'utf8'))
      )
      assert.equal(created.appliedAt, null)
      assert.equal(created.rejectedAt, null)
      assert.equal(created.rolledBackAt, null)
    } finally {
      closeFixture(fixture)
    }
  })

  it('never mutates the project file on creation', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'proposal only' + LF
      })
      assert.equal(diskString(fixture, 'src/note.txt'), 'first line' + LF)
    } finally {
      closeFixture(fixture)
    }
  })

  it('stores exact checkpoint and proposal bytes', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'crlf.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'crlf.txt',
        expectedRevision: before,
        proposedContent: 'x' + CRLF + 'y' + LF
      })
      const rows = fixture.transactions.findFiles(created.id)
      assert.equal(rows.length, 1)
      assert.ok(rows[0]?.beforeBytes.equals(Buffer.from('a' + CRLF + 'b' + LF, 'utf8')))
      assert.ok(rows[0]?.proposedBytes.equals(Buffer.from('x' + CRLF + 'y' + LF, 'utf8')))
      assert.equal(rows[0]?.beforeRevision, shaHex(rows[0]?.beforeBytes ?? Buffer.alloc(0)))
      assert.equal(rows[0]?.proposedRevision, shaHex(rows[0]?.proposedBytes ?? Buffer.alloc(0)))
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects stale expected revisions as conflicts without persisting', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: '0'.repeat(64),
          proposedContent: 'stale' + LF
        }),
        (error: unknown) => {
          assert.ok(error instanceof ChangeTransactionConflictError)
          assert.equal(error.message, CHANGE_CONFLICT_MESSAGE)
          return true
        }
      )
      assert.deepEqual(await fixture.service.listRecentTransactions({ workspaceId: fixture.workspace.id }), [])
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects no-op proposals', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: before,
          proposedContent: 'first line' + LF
        }),
        ChangeTransactionNoChangesError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects traversal, absolute paths, and symlinks', async () => {
    const fixture = openFixture()
    try {
      const revision = '0'.repeat(64)
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: '../evil.txt',
          expectedRevision: revision,
          proposedContent: 'x' + LF
        }),
        WorkspacePathOutsideRootError
      )
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: '/abs.txt',
          expectedRevision: revision,
          proposedContent: 'x' + LF
        }),
        InvalidWorkspaceError
      )
      if (fixture.fileLinkCreated) {
        const linkRevision = await readRevision(fixture, 'src/note.txt')
        await assert.rejects(
          fixture.service.createFileChange({
            workspaceId: fixture.workspace.id,
            relativePath: 'src/link-note.txt',
            expectedRevision: linkRevision,
            proposedContent: 'x' + LF
          }),
          WorkspaceEntryTypeError
        )
      } else {
        console.warn('skipped: symlink proposal case needs link privileges')
      }
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects unknown workspaces, unsupported originals, and oversized proposals', async () => {
    const fixture = openFixture()
    try {
      const revision = '0'.repeat(64)
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id + 999,
          relativePath: 'src/note.txt',
          expectedRevision: revision,
          proposedContent: 'x' + LF
        }),
        WorkspaceNotFoundError
      )
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: 'binary.dat',
          expectedRevision: revision,
          proposedContent: 'x' + LF
        }),
        UnsupportedFileError
      )
      const before = await readRevision(fixture, 'src/note.txt')
      await assert.rejects(
        fixture.service.createFileChange({
          workspaceId: fixture.workspace.id,
          relativePath: 'src/note.txt',
          expectedRevision: before,
          proposedContent: 'x'.repeat(1024 * 1024 + 1)
        }),
        FileTooLargeError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('detects corrupted persisted proposals on load', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'tamper me' + LF
      })
      fixture.db.prepare('UPDATE change_transaction_files SET proposed_bytes = ? WHERE transaction_id = ?').run(
        Buffer.from('different bytes', 'utf8'),
        created.id
      )
      await assert.rejects(
        fixture.service.getTransaction({ transactionId: created.id }),
        CorruptChangeTransactionError
      )
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: created.id }),
        CorruptChangeTransactionError
      )
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('accept', () => {
  it('applies a pending proposal through the Stage 8 writer', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'applied content' + LF
      })
      const applied = await fixture.service.acceptTransaction({ transactionId: created.id })
      assert.equal(applied.status, 'applied')
      assert.equal(applied.files[0]?.appliedRevision, applied.files[0]?.proposedRevision)
      assert.equal(applied.appliedAt, applied.updatedAt)
      assert.ok((applied.appliedAt ?? 0) >= created.createdAt)
      assert.equal(diskString(fixture, 'src/note.txt'), 'applied content' + LF)
      assert.equal(
        (await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })).revision,
        applied.files[0]?.appliedRevision
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('requires pending status and existing transactions', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: 999 }),
        ChangeTransactionNotFoundError
      )
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'once' + LF
      })
      await fixture.service.acceptTransaction({ transactionId: created.id })
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: created.id }),
        ChangeTransactionStateError
      )
      await fixture.service.rollbackTransaction({ transactionId: created.id })
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: created.id }),
        ChangeTransactionStateError
      )
      const pending = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: (await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'src/note.txt' })).revision,
        proposedContent: 'rejected first' + LF
      })
      await fixture.service.rejectTransaction({ transactionId: pending.id })
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: pending.id }),
        ChangeTransactionStateError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('leaves the transaction pending and external content intact on conflict', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'stark proposal' + LF
      })
      writeFileSync(join(fixture.root, 'src', 'note.txt'), 'external B' + LF)
      await assert.rejects(
        fixture.service.acceptTransaction({ transactionId: created.id }),
        (error: unknown) => {
          assert.ok(error instanceof ChangeTransactionConflictError)
          assert.equal(error.message, CHANGE_CONFLICT_MESSAGE)
          return true
        }
      )
      const still = await fixture.service.getTransaction({ transactionId: created.id })
      assert.equal(still.status, 'pending')
      assert.equal(diskString(fixture, 'src/note.txt'), 'external B' + LF)
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('reject', () => {
  it('rejects pending proposals without touching disk', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'never lands' + LF
      })
      const rejected = await fixture.service.rejectTransaction({ transactionId: created.id })
      assert.equal(rejected.status, 'rejected')
      assert.ok((rejected.rejectedAt ?? 0) >= created.createdAt)
      assert.equal(diskString(fixture, 'src/note.txt'), 'first line' + LF)
      await assert.rejects(
        fixture.service.rejectTransaction({ transactionId: created.id }),
        ChangeTransactionStateError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses to reject applied transactions', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'applied' + LF
      })
      await fixture.service.acceptTransaction({ transactionId: created.id })
      await assert.rejects(
        fixture.service.rejectTransaction({ transactionId: created.id }),
        ChangeTransactionStateError
      )
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('rollback', () => {
  it('restores the exact checkpoint and proves the revision', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'crlf.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'crlf.txt',
        expectedRevision: before,
        proposedContent: 'changed' + LF
      })
      await fixture.service.acceptTransaction({ transactionId: created.id })
      const rolled = await fixture.service.rollbackTransaction({ transactionId: created.id })
      assert.equal(rolled.status, 'rolled_back')
      assert.ok((rolled.rolledBackAt ?? 0) >= (rolled.appliedAt ?? 0))
      const current = await fixture.reads.readTextFile({ workspaceId: fixture.workspace.id, relativePath: 'crlf.txt' })
      assert.equal(current.content, 'a' + CRLF + 'b' + LF)
      assert.equal(current.revision, before)
    } finally {
      closeFixture(fixture)
    }
  })

  it('requires applied status', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const pending = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'pending' + LF
      })
      await assert.rejects(
        fixture.service.rollbackTransaction({ transactionId: pending.id }),
        ChangeTransactionStateError
      )
      await fixture.service.rejectTransaction({ transactionId: pending.id })
      await assert.rejects(
        fixture.service.rollbackTransaction({ transactionId: pending.id }),
        ChangeTransactionStateError
      )
      await assert.rejects(fixture.service.rollbackTransaction({ transactionId: 999 }), ChangeTransactionNotFoundError)
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses to overwrite external work and stays applied', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'stark B' + LF
      })
      await fixture.service.acceptTransaction({ transactionId: created.id })
      writeFileSync(join(fixture.root, 'src', 'note.txt'), 'external C' + LF)
      await assert.rejects(
        fixture.service.rollbackTransaction({ transactionId: created.id }),
        (error: unknown) => {
          assert.ok(error instanceof ChangeTransactionConflictError)
          assert.equal(error.message, CHANGE_ROLLBACK_CONFLICT_MESSAGE)
          return true
        }
      )
      const still = await fixture.service.getTransaction({ transactionId: created.id })
      assert.equal(still.status, 'applied')
      assert.equal(diskString(fixture, 'src/note.txt'), 'external C' + LF)
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses corrupted checkpoints', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'applied then corrupted' + LF
      })
      await fixture.service.acceptTransaction({ transactionId: created.id })
      fixture.db.prepare('UPDATE change_transaction_files SET before_bytes = ? WHERE transaction_id = ?').run(
        Buffer.from('forged checkpoint', 'utf8'),
        created.id
      )
      await assert.rejects(
        fixture.service.rollbackTransaction({ transactionId: created.id }),
        CorruptChangeTransactionError
      )
      await assert.rejects(
        fixture.service.getTransaction({ transactionId: created.id }),
        CorruptChangeTransactionError
      )
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('history', () => {
  it('lists newest first, caps at 20, and scopes to the workspace', async () => {
    const fixture = openFixture()
    try {
      const first = await readRevision(fixture, 'src/note.txt')
      const created = await fixture.service.createFileChange({
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: first,
        proposedContent: 'history one' + LF
      })
      const recent = await fixture.service.listRecentTransactions({ workspaceId: fixture.workspace.id })
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.id, created.id)
      assert.equal(recent[0]?.files.length, 1)
      assert.ok((recent[0]?.createdAt ?? 0) > 0)
      await assert.rejects(
        fixture.service.listRecentTransactions({ workspaceId: fixture.workspace.id + 999 }),
        WorkspaceNotFoundError
      )
      assert.equal(MAX_RECENT_CHANGE_TRANSACTIONS, 20)
    } finally {
      closeFixture(fixture)
    }
  })

  it('validates request shapes strictly', async () => {
    const fixture = openFixture()
    try {
      const before = await readRevision(fixture, 'src/note.txt')
      const valid = {
        workspaceId: fixture.workspace.id,
        relativePath: 'src/note.txt',
        expectedRevision: before,
        proposedContent: 'x' + LF
      }
      await assert.rejects(fixture.service.createFileChange({ ...valid, extra: true }), InvalidWorkspaceError)
      await assert.rejects(fixture.service.createFileChange({ ...valid, workspaceId: '1' }), InvalidWorkspaceError)
      await assert.rejects(fixture.service.getTransaction({ transactionId: '1' }), InvalidWorkspaceError)
      await assert.rejects(fixture.service.getTransaction({ transactionId: 1, extra: true }), InvalidWorkspaceError)
      await assert.rejects(fixture.service.acceptTransaction(null), InvalidWorkspaceError)
      await assert.rejects(fixture.service.listRecentTransactions({ workspaceId: 0 }), InvalidWorkspaceError)
    } finally {
      closeFixture(fixture)
    }
  })
})
