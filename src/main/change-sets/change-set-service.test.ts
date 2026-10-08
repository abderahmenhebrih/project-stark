import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService, deriveChangeSetStatus } from './change-set-service'
import { ChangeSetNotFoundError, InvalidChangeSetRequestError } from './errors'

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  service: ChangeSetService
  transactions: ChangeTransactionService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-svc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'const b = 1\n')
  writeFileSync(join(root, 'c.ts'), 'const c = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const writer = new WorkspaceFileWriteService(workspaces)
  return {
    db,
    dir,
    root,
    workspaceId,
    service: new ChangeSetService(workspaces, setRows, changeRows),
    transactions: new ChangeTransactionService(workspaces, changeRows, writer)
  }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function revisionOf(harness: { root: string }, relativePath: string): Promise<string> {
  return createHash('sha256').update(readFileSync(join(harness.root, relativePath))).digest('hex')
}

function setCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('change set service', () => {
  it('creates an atomic 2-file set with pending children', async () => {
    const harness = openHarness()
    try {
      const set = await harness.service.createAiChangeSet(harness.workspaceId, 'grouped update', [
        { relativePath: 'a.ts', expectedRevision: await revisionOf(harness, 'a.ts'), proposedContent: 'const a = 2\n', fileSummary: 'bump a' },
        { relativePath: 'b.ts', expectedRevision: await revisionOf(harness, 'b.ts'), proposedContent: 'const b = 2\n', fileSummary: 'bump b' }
      ])
      assert.equal(set.workspaceId, harness.workspaceId)
      assert.equal(set.kind, 'ai_multi_file_proposal')
      assert.equal(set.summary, 'grouped update')
      assert.equal(set.items.length, 2)
      assert.deepEqual(set.items.map((item) => item.ordinal), [0, 1])
      assert.deepEqual(set.items.map((item) => item.fileSummary), ['bump a', 'bump b'])
      for (const item of set.items) {
        assert.equal(item.transaction.status, 'pending')
      }
      assert.equal(set.items[0]?.transaction.files[0]?.relativePath, 'a.ts')
    } finally {
      closeHarness(harness)
    }
  })

  it('validation failure creates nothing', async () => {
    const harness = openHarness()
    try {
      await assert.rejects(
        harness.service.createAiChangeSet(harness.workspaceId, 'bad', [
          { relativePath: 'a.ts', expectedRevision: await revisionOf(harness, 'a.ts'), proposedContent: 'const a = 2\n', fileSummary: 'ok' },
          { relativePath: 'missing.ts', expectedRevision: '0'.repeat(64), proposedContent: 'x\n', fileSummary: 'ok' }
        ]),
        Error
      )
      assert.equal(setCount(harness.db), 0)
      const txCount = harness.db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get() as unknown as Record<string, unknown>
      assert.equal(txCount['n'], 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('rejects empty files and bad summaries', async () => {
    const harness = openHarness()
    try {
      const revision = await revisionOf(harness, 'a.ts')
      await assert.rejects(harness.service.createAiChangeSet(harness.workspaceId, 's', []), InvalidChangeSetRequestError)
      await assert.rejects(
        harness.service.createAiChangeSet(harness.workspaceId, '   ', [
          { relativePath: 'a.ts', expectedRevision: revision, proposedContent: 'x\n', fileSummary: 'ok' }
        ]),
        InvalidChangeSetRequestError
      )
      await assert.rejects(
        harness.service.createAiChangeSet(harness.workspaceId, 's', [
          { relativePath: 'a.ts', expectedRevision: revision, proposedContent: 'x\n', fileSummary: '   ' }
        ]),
        InvalidChangeSetRequestError
      )
      assert.equal(setCount(harness.db), 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('gets one set and lists recent with workspace filtering', async () => {
    const harness = openHarness()
    try {
      const revision = await revisionOf(harness, 'a.ts')
      const created = await harness.service.createAiChangeSet(harness.workspaceId, 'first', [
        { relativePath: 'a.ts', expectedRevision: revision, proposedContent: 'const a = 9\n', fileSummary: 'nine' }
      ])
      const fetched = await harness.service.getChangeSet({ changeSetId: created.id })
      assert.equal(fetched.id, created.id)
      assert.equal(fetched.items[0]?.fileSummary, 'nine')
      await assert.rejects(harness.service.getChangeSet({ changeSetId: 999999 }), ChangeSetNotFoundError)
      await assert.rejects(harness.service.getChangeSet({ nope: 1 }), InvalidChangeSetRequestError)
      const recent = await harness.service.listRecentChangeSets({ workspaceId: harness.workspaceId })
      assert.equal(recent.length, 1)
      assert.deepEqual(await harness.service.listRecentChangeSets({ workspaceId: 999999 }).catch(() => 'threw'), 'threw')
    } finally {
      closeHarness(harness)
    }
  })

  it('derives pending, partially_resolved, and resolved states', async () => {
    const harness = openHarness()
    try {
      const set = await harness.service.createAiChangeSet(harness.workspaceId, 'trio', [
        { relativePath: 'a.ts', expectedRevision: await revisionOf(harness, 'a.ts'), proposedContent: 'const a = 2\n', fileSummary: 'a' },
        { relativePath: 'b.ts', expectedRevision: await revisionOf(harness, 'b.ts'), proposedContent: 'const b = 2\n', fileSummary: 'b' },
        { relativePath: 'c.ts', expectedRevision: await revisionOf(harness, 'c.ts'), proposedContent: 'const c = 2\n', fileSummary: 'c' }
      ])
      const txIds = set.items.map((item) => item.transaction.id)
      assert.equal(deriveChangeSetStatus(['pending', 'pending', 'pending']), 'pending')
      await harness.transactions.acceptTransaction({ transactionId: txIds[0] })
      await harness.transactions.rejectTransaction({ transactionId: txIds[1] })
      const partial = await harness.service.getChangeSet({ changeSetId: set.id })
      assert.equal(
        deriveChangeSetStatus(partial.items.map((item) => item.transaction.status)),
        'partially_resolved'
      )
      assert.equal(partial.items[0]?.transaction.status, 'applied')
      assert.equal(partial.items[1]?.transaction.status, 'rejected')
      assert.equal(partial.items[2]?.transaction.status, 'pending')
      assert.equal(deriveChangeSetStatus(['applied', 'rejected', 'rolled_back']), 'resolved')
    } finally {
      closeHarness(harness)
    }
  })
})
