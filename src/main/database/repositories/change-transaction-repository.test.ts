import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../migrations/index'
import { ChangeTransactionRepository } from './change-transaction-repository'
import { WorkspaceRepository } from './workspace-repository'

const LF = String.fromCharCode(10)
const CRLF = String.fromCharCode(13, 10)

function openRepositories(): {
  db: DatabaseSync
  changes: ChangeTransactionRepository
  workspaces: WorkspaceRepository
} {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db, migrations)
  return { db, changes: new ChangeTransactionRepository(db), workspaces: new WorkspaceRepository(db) }
}

function openWorkspace(workspaces: WorkspaceRepository, name: string, now: number): number {
  return workspaces.create({ rootPath: `C:\\proj\\${name}`, displayName: name, now }).id
}

describe('change transaction repository', () => {
  it('creates a transaction and reads the header back', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const id = changes.createWithFiles({ workspaceId, now: 1000 }, [])
      assert.ok(id > 0)
      const header = changes.findTransaction(id)
      assert.equal(header?.workspaceId, workspaceId)
      assert.equal(header?.status, 'pending')
      assert.equal(header?.createdAt, 1000)
      assert.equal(header?.updatedAt, 1000)
      assert.equal(header?.appliedAt, null)
      assert.equal(header?.rejectedAt, null)
      assert.equal(header?.rolledBackAt, null)
      assert.deepEqual(changes.findFiles(id), [])
    } finally {
      db.close()
    }
  })

  it('round-trips exact checkpoint and proposal bytes through BLOB storage', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const beforeBytes = Buffer.from('héllo' + CRLF + '✓' + LF, 'utf8')
      const proposedBytes = Buffer.from('héllo changed' + CRLF + '✓' + LF, 'utf8')
      const id = changes.createWithFiles({ workspaceId, now: 1000 }, [
        {
          relativePath: 'src/note.txt',
          beforeRevision: 'a'.repeat(64),
          beforeBytes,
          proposedRevision: 'b'.repeat(64),
          proposedBytes
        }
      ])
      const rows = changes.findFiles(id)
      assert.equal(rows.length, 1)
      assert.ok(rows[0]?.beforeBytes instanceof Buffer)
      assert.ok(rows[0]?.beforeBytes.equals(beforeBytes))
      assert.ok(rows[0]?.proposedBytes.equals(proposedBytes))
      assert.equal(rows[0]?.beforeRevision, 'a'.repeat(64))
      assert.equal(rows[0]?.proposedRevision, 'b'.repeat(64))
      assert.equal(rows[0]?.appliedRevision, null)
      assert.equal(rows[0]?.relativePath, 'src/note.txt')
      assert.equal(rows[0]?.transactionId, id)
    } finally {
      db.close()
    }
  })

  it('persists empty-file checkpoints exactly', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const id = changes.createWithFiles({ workspaceId, now: 1000 }, [
        {
          relativePath: 'empty.txt',
          beforeRevision: 'c'.repeat(64),
          beforeBytes: Buffer.alloc(0),
          proposedRevision: 'd'.repeat(64),
          proposedBytes: Buffer.from('now something' + LF, 'utf8')
        }
      ])
      const rows = changes.findFiles(id)
      assert.equal(rows[0]?.beforeBytes.byteLength, 0)
      assert.ok(rows[0]?.beforeBytes.equals(Buffer.alloc(0)))
    } finally {
      db.close()
    }
  })

  it('rolls back every row when creation fails partway', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const file = {
        relativePath: 'good.txt',
        beforeRevision: 'a'.repeat(64),
        beforeBytes: Buffer.from('good' + LF, 'utf8'),
        proposedRevision: 'b'.repeat(64),
        proposedBytes: Buffer.from('better' + LF, 'utf8')
      }
      assert.throws(() =>
        changes.createWithFiles({ workspaceId, now: 1000 }, [
          file,
          { ...file, relativePath: 'good.txt' }
        ])
      )
      assert.deepEqual(changes.listRecentForWorkspace(workspaceId, 20), [])
    } finally {
      db.close()
    }
  })

  it('marks applied with revision persistence and timestamps', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const id = changes.createWithFiles({ workspaceId, now: 1000 }, [])
      assert.equal(changes.markApplied(id, 'e'.repeat(64), 2000), true)
      const header = changes.findTransaction(id)
      assert.equal(header?.status, 'applied')
      assert.equal(header?.appliedAt, 2000)
      assert.equal(header?.updatedAt, 2000)
      // Applied twice is refused: the conditional update only matches pending.
      assert.equal(changes.markApplied(id, 'e'.repeat(64), 2001), false)
      assert.equal(changes.markRejected(id, 2002), false)
    } finally {
      db.close()
    }
  })

  it('marks rejected and rolled_back with timestamps, keeping history rows', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'a', 1000)
      const rejected = changes.createWithFiles({ workspaceId, now: 1000 }, [])
      assert.equal(changes.markRejected(rejected, 2000), true)
      assert.equal(changes.markRejected(rejected, 2001), false)
      const rejectedHeader = changes.findTransaction(rejected)
      assert.equal(rejectedHeader?.status, 'rejected')
      assert.equal(rejectedHeader?.rejectedAt, 2000)
      assert.equal(rejectedHeader?.updatedAt, 2000)

      const rolled = changes.createWithFiles({ workspaceId, now: 1001 }, [])
      assert.equal(changes.markRolledBack(rolled, 2002), false)
      assert.equal(changes.markApplied(rolled, 'e'.repeat(64), 2002), true)
      assert.equal(changes.markRolledBack(rolled, 2003), true)
      assert.equal(changes.markRolledBack(rolled, 2004), false)
      const rolledHeader = changes.findTransaction(rolled)
      assert.equal(rolledHeader?.status, 'rolled_back')
      assert.equal(rolledHeader?.rolledBackAt, 2003)

      // Rejected and rolled-back rows remain readable history.
      assert.equal(changes.listRecentForWorkspace(workspaceId, 20).length, 2)
    } finally {
      db.close()
    }
  })

  it('lists newest first, filters by workspace, and caps at the limit', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const first = openWorkspace(workspaces, 'first', 1000)
      const second = openWorkspace(workspaces, 'second', 1000)
      const ids: number[] = []
      for (let i = 0; i < 5; i += 1) {
        ids.push(changes.createWithFiles({ workspaceId: first, now: 1000 + i }, []))
      }
      const other = changes.createWithFiles({ workspaceId: second, now: 5000 }, [])
      const recent = changes.listRecentForWorkspace(first, 3)
      assert.deepEqual(
        recent.map((row) => row.id),
        [ids[4], ids[3], ids[2]]
      )
      assert.ok(!recent.some((row) => row.id === other))
      const all = changes.listRecentForWorkspace(second, 20)
      assert.deepEqual(all.map((row) => row.id), [other])
    } finally {
      db.close()
    }
  })

  it('returns undefined or false for missing transactions', () => {
    const { db, changes } = openRepositories()
    try {
      assert.equal(changes.findTransaction(999), undefined)
      assert.deepEqual(changes.findFiles(999), [])
      assert.equal(changes.markApplied(999, 'e'.repeat(64), 1), false)
      assert.equal(changes.markRejected(999, 1), false)
      assert.equal(changes.markRolledBack(999, 1), false)
    } finally {
      db.close()
    }
  })

  it('cascades transaction rows when the workspace is deleted', () => {
    const { db, changes, workspaces } = openRepositories()
    try {
      const workspaceId = openWorkspace(workspaces, 'doomed', 1000)
      const id = changes.createWithFiles({ workspaceId, now: 1000 }, [])
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)
      assert.equal(changes.findTransaction(id), undefined)
    } finally {
      db.close()
    }
  })
})
