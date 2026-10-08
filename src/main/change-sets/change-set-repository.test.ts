import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { DatabaseError } from '../database/errors'

function sha256Hex(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

function openRepositories(): {
  db: DatabaseSync
  sets: ChangeSetRepository
  transactions: ChangeTransactionRepository
  workspaces: WorkspaceRepository
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  db.exec('PRAGMA foreign_keys = ON')
  const workspaces = new WorkspaceRepository(db)
  const workspaceId = workspaces.create({ rootPath: 'w', displayName: 'w', now: 1000 }).id
  return { db, sets: new ChangeSetRepository(db), transactions: new ChangeTransactionRepository(db), workspaces, workspaceId }
}

function item(relativePath: string, before: string, proposed: string, ordinal: number, fileSummary = 'update'): {
  relativePath: string
  beforeRevision: string
  beforeBytes: Buffer
  proposedRevision: string
  proposedBytes: Buffer
  ordinal: number
  fileSummary: string
} {
  return {
    relativePath,
    beforeRevision: sha256Hex(before),
    beforeBytes: Buffer.from(before, 'utf8'),
    proposedRevision: sha256Hex(proposed),
    proposedBytes: Buffer.from(proposed, 'utf8'),
    ordinal,
    fileSummary
  }
}

function tableCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('change set repository', () => {
  it('creates a 2-file set with summaries, ordinals, and linkage', () => {
    const { db, sets, workspaceId } = openRepositories()
    try {
      const id = sets.createChangeSet(
        { workspaceId, kind: 'ai_multi_file_proposal', summary: 'grouped update', now: 2000 },
        [item('a.ts', 'a1\n', 'a2\n', 0, 'bump a'), item('b.ts', 'b1\n', 'b2\n', 1, 'bump b')]
      )
      const header = sets.findChangeSetById(id)
      assert.equal(header?.summary, 'grouped update')
      assert.equal(header?.kind, 'ai_multi_file_proposal')
      const links = sets.findItems(id)
      assert.equal(links.length, 2)
      assert.deepEqual(links.map((link) => link.ordinal), [0, 1])
      assert.deepEqual(links.map((link) => link.fileSummary), ['bump a', 'bump b'])
      assert.ok(links[0]?.transactionId !== links[1]?.transactionId)
      assert.equal(tableCount(db, 'change_transactions'), 2)
      assert.equal(tableCount(db, 'change_transaction_files'), 2)
      assert.equal(tableCount(db, 'change_set_items'), 2)
    } finally {
      db.close()
    }
  })

  it('creates a 5-file set', () => {
    const { db, sets, workspaceId } = openRepositories()
    try {
      const id = sets.createChangeSet(
        { workspaceId, kind: 'ai_multi_file_proposal', summary: 'big group', now: 2000 },
        Array.from({ length: 5 }, (_, index) =>
          item(`f${String(index)}.ts`, `before ${String(index)}\n`, `after ${String(index)}\n`, index, `file ${String(index)}`)
        )
      )
      assert.equal(sets.findItems(id).length, 5)
      assert.equal(tableCount(db, 'change_transactions'), 5)
    } finally {
      db.close()
    }
  })

  it('stores exact before/proposed BLOBs', () => {
    const { db, sets, transactions, workspaceId } = openRepositories()
    try {
      const before = 'const x = 1\n// ünïcodé ✓\n'
      const proposed = 'const x = 2\n// ünïcodé ✓\n'
      const id = sets.createChangeSet(
        { workspaceId, kind: 'ai_multi_file_proposal', summary: 's', now: 2000 },
        [item('a.ts', before, proposed, 0)]
      )
      const link = sets.findItems(id)[0]
      assert.ok(link !== undefined)
      const files = transactions.findFiles(link.transactionId)
      assert.equal(files[0]?.beforeBytes.toString('utf8'), before)
      assert.equal(files[0]?.proposedBytes.toString('utf8'), proposed)
      assert.equal(files[0]?.beforeRevision, sha256Hex(before))
      assert.equal(files[0]?.proposedRevision, sha256Hex(proposed))
    } finally {
      db.close()
    }
  })

  it('rolls back the whole aggregate when item insertion fails', () => {
    const { db, sets, workspaceId } = openRepositories()
    try {
      assert.throws(() =>
        sets.createChangeSet(
          { workspaceId, kind: 'ai_multi_file_proposal', summary: 's', now: 2000 },
          [
            item('a.ts', 'a1\n', 'a2\n', 0),
            item('b.ts', 'b1\n', 'b2\n', 1),
            item('c.ts', 'c1\n', 'c2\n', 2)
          ],
          { failAfterItems: 1 }
        )
      )
      assert.equal(tableCount(db, 'change_sets'), 0)
      assert.equal(tableCount(db, 'change_set_items'), 0)
      assert.equal(tableCount(db, 'change_transactions'), 0)
      assert.equal(tableCount(db, 'change_transaction_files'), 0)
    } finally {
      db.close()
    }
  })

  it('gets one set and lists recent newest-first capped at 20 with workspace filtering', () => {
    const { db, sets, workspaces, workspaceId } = openRepositories()
    try {
      const other = workspaces.create({ rootPath: 'other', displayName: 'other', now: 1000 }).id
      for (let index = 0; index < 22; index += 1) {
        sets.createChangeSet(
          { workspaceId, kind: 'ai_multi_file_proposal', summary: `set ${String(index)}`, now: 2000 + index },
          [item(`f${String(index)}.ts`, 'a\n', 'b\n', 0)]
        )
      }
      sets.createChangeSet(
        { workspaceId: other, kind: 'ai_multi_file_proposal', summary: 'other', now: 9999 },
        [item('z.ts', 'a\n', 'b\n', 0)]
      )
      const recent = sets.listRecentForWorkspace(workspaceId, 20)
      assert.equal(recent.length, 20)
      assert.equal(recent[0]?.summary, 'set 21')
      assert.ok(!recent.some((entry) => entry.summary === 'other'))
      const first = sets.findChangeSetById(recent[0]?.id ?? 0)
      assert.equal(first?.summary, 'set 21')
      assert.equal(sets.findChangeSetById(999999), undefined)
      assert.deepEqual(sets.listRecentForWorkspace(999999, 20), [])
    } finally {
      db.close()
    }
  })

  it('cascades items when the set is deleted and when the transaction is deleted', () => {
    const { db, sets, workspaceId } = openRepositories()
    try {
      const id = sets.createChangeSet(
        { workspaceId, kind: 'ai_multi_file_proposal', summary: 's', now: 2000 },
        [item('a.ts', 'a\n', 'b\n', 0)]
      )
      const link = sets.findItems(id)[0]
      assert.ok(link !== undefined)
      db.exec(`DELETE FROM change_sets WHERE id = ${id}`)
      assert.equal(tableCount(db, 'change_set_items'), 0)
      assert.equal(tableCount(db, 'change_transactions'), 1)
      db.exec(`DELETE FROM change_transactions WHERE id = ${link.transactionId}`)
      assert.equal(tableCount(db, 'change_transaction_files'), 0)
    } finally {
      db.close()
    }
  })

  it('rejects malformed stored rows safely', () => {
    const { db, sets, workspaceId } = openRepositories()
    try {
      const id = sets.createChangeSet(
        { workspaceId, kind: 'ai_multi_file_proposal', summary: 's', now: 2000 },
        [item('a.ts', 'a\n', 'b\n', 0)]
      )
      // SQLite is dynamically typed: corrupt the column type directly
      // (an INTEGER column holding TEXT survives storage).
      db.exec(`UPDATE change_sets SET created_at = 'not-a-number' WHERE id = ${id}`)
      assert.throws(() => sets.findChangeSetById(id), DatabaseError)
    } finally {
      db.close()
    }
  })
})
