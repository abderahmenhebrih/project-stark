import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices, type ApplicationServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { IpcChannel } from '../../shared/constants'
import { createIpcBindings } from './index'
import { createChangeTransactionBindings } from './change-transactions'

const LF = String.fromCharCode(10)

function openServices(): { db: DatabaseSync; services: ApplicationServices } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const keyValue = new KeyValueRepository(db)
  return {
    db,
    services: createServices({
      keyValue,
      workspaces: new WorkspaceRepository(db),
      changeTransactions: new ChangeTransactionRepository(db)
    })
  }
}

function openFixture(): {
  db: DatabaseSync
  services: ApplicationServices
  dir: string
  root: string
} {
  const { db, services } = openServices()
  const dir = mkdtempSync(join(tmpdir(), 'stark-changetx-ipc-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'note.txt'), 'change me' + LF)
  return { db, services, dir, root }
}

const EXPECTED_CHANNELS: readonly IpcChannel[] = [
  'stark:changes:create',
  'stark:changes:get',
  'stark:changes:list-recent',
  'stark:changes:accept',
  'stark:changes:reject',
  'stark:changes:rollback'
]

function changesBindings(services: ApplicationServices): ReturnType<typeof createChangeTransactionBindings> {
  return createChangeTransactionBindings(services.changeTransactionService)
}

describe('change-transaction IPC bindings', () => {
  it('exposes exactly the six changes channels and nothing else', () => {
    const { db, services } = openServices()
    try {
      const channels = changesBindings(services).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_CHANNELS].sort())
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        for (const forbidden of [
          'fs:',
          'filesystem:',
          'db:',
          'sql:',
          'dialog:',
          'transaction:execute',
          'save-as',
          'write-path',
          'exec',
          'shell:'
        ]) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains the changes channels', () => {
    const { db, services } = openServices()
    try {
      const channels = createIpcBindings({
        settingsService: services.settingsService,
        profileService: services.profileService,
        workspaceService: services.workspaceService,
        workspaceFilesService: services.workspaceFilesService,
        workspaceFileWriteService: services.workspaceFileWriteService,
        workspaceSearchService: services.workspaceSearchService,
        changeTransactionService: services.changeTransactionService
      }).map((binding) => binding.channel)
      for (const expected of EXPECTED_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      for (const channel of channels) {
        assert.ok(!channel.includes('transaction:execute'), 'no generic transaction channel may exist')
        assert.ok(!channel.startsWith('db:'), 'no database channel may exist')
        assert.ok(!channel.startsWith('sql:'), 'no SQL channel may exist')
      }
    } finally {
      db.close()
    }
  })

  it('create delegates to the service without touching disk', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = changesBindings(fixture.services)
      const create = bindings.find((binding) => binding.channel === 'stark:changes:create')
      assert.ok(create !== undefined)
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/note.txt'
      })
      const transaction = (await create.invoke({
        workspaceId: created.id,
        relativePath: 'src/note.txt',
        expectedRevision: before.revision,
        proposedContent: 'proposed' + LF
      })) as { id: number; status: string; files: { relativePath: string }[] }
      assert.equal(transaction.status, 'pending')
      assert.equal(transaction.files[0]?.relativePath, 'src/note.txt')
      const direct = await fixture.services.changeTransactionService.getTransaction({ transactionId: transaction.id })
      assert.deepEqual(direct, transaction)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('get, list-recent, accept, reject, and rollback delegate to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = changesBindings(fixture.services)
      const find = (channel: IpcChannel): ((payload?: unknown) => Promise<unknown>) => {
        const binding = bindings.find((entry) => entry.channel === channel)
        assert.ok(binding !== undefined)
        return binding.invoke
      }
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/note.txt'
      })
      const pending = (await find('stark:changes:create')({
        workspaceId: created.id,
        relativePath: 'src/note.txt',
        expectedRevision: before.revision,
        proposedContent: 'listed' + LF
      })) as { id: number }
      const listed = (await find('stark:changes:list-recent')({ workspaceId: created.id })) as { id: number }[]
      assert.ok(listed.some((entry) => entry.id === pending.id))
      const fetched = (await find('stark:changes:get')({ transactionId: pending.id })) as { status: string }
      assert.equal(fetched.status, 'pending')
      const accepted = (await find('stark:changes:accept')({ transactionId: pending.id })) as { status: string }
      assert.equal(accepted.status, 'applied')
      const rolled = (await find('stark:changes:rollback')({ transactionId: pending.id })) as { status: string }
      assert.equal(rolled.status, 'rolled_back')

      const second = (await find('stark:changes:create')({
        workspaceId: created.id,
        relativePath: 'src/note.txt',
        expectedRevision: (
          (await find('stark:changes:get')({ transactionId: pending.id })) as {
            files: { beforeRevision: string }[]
          }
        ).files[0]?.beforeRevision,
        proposedContent: 'rejected' + LF
      })) as { id: number }
      const rejected = (await find('stark:changes:reject')({ transactionId: second.id })) as { status: string }
      assert.equal(rejected.status, 'rejected')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates every operation at runtime', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = changesBindings(fixture.services)
      const find = (channel: IpcChannel): ((payload?: unknown) => Promise<unknown>) => {
        const binding = bindings.find((entry) => entry.channel === channel)
        assert.ok(binding !== undefined)
        return binding.invoke
      }
      const create = find('stark:changes:create')
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/note.txt'
      })
      const valid = {
        workspaceId: created.id,
        relativePath: 'src/note.txt',
        expectedRevision: before.revision,
        proposedContent: 'x' + LF
      }
      for (const bad of [
        null,
        'x',
        42,
        {},
        { ...valid, workspaceId: '1' },
        { ...valid, workspaceId: 0 },
        { ...valid, relativePath: '../evil.txt' },
        { ...valid, relativePath: '/abs.txt' },
        { ...valid, expectedRevision: 'short' },
        { ...valid, proposedContent: 42 },
        { ...valid, extra: true }
      ]) {
        await assert.rejects(create(bad), /We couldn’t update this change\.|This file changed on disk\.|There are no changes/)
      }
      for (const channel of ['stark:changes:get', 'stark:changes:accept', 'stark:changes:reject', 'stark:changes:rollback'] as const) {
        const invoke = find(channel)
        for (const bad of [null, '1', 0, -3, 1.5, {}, { transactionId: '1' }, { transactionId: 1, extra: true }]) {
          await assert.rejects(invoke(bad), /We couldn’t update this change\.|That change/)
        }
      }
      await assert.rejects(
        find('stark:changes:list-recent')({ workspaceId: '1' }),
        /We couldn’t update this change\./
      )
      await assert.rejects(
        find('stark:changes:list-recent')({ workspaceId: created.id + 999 }),
        /That project folder is no longer available\./
      )
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps conflicts and failures to safe public copy', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = changesBindings(fixture.services)
      const create = bindings.find((binding) => binding.channel === 'stark:changes:create')
      assert.ok(create !== undefined)
      await assert.rejects(
        create.invoke({
          workspaceId: created.id,
          relativePath: 'src/note.txt',
          expectedRevision: '0'.repeat(64),
          proposedContent: 'stale' + LF
        }),
        /This file changed on disk\. Reload it before saving your changes\./
      )
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/note.txt'
      })
      await assert.rejects(
        create.invoke({
          workspaceId: created.id,
          relativePath: 'src/note.txt',
          expectedRevision: before.revision,
          proposedContent: before.content
        }),
        /There are no changes to review\./
      )
      const message = await create
        .invoke({ workspaceId: created.id, relativePath: 'missing.txt', expectedRevision: before.revision, proposedContent: 'x' + LF })
        .then(
          () => 'unexpected success',
          (error: unknown) => (error instanceof Error ? error.message : 'non-error')
        )
      assert.ok(!message.includes('ENOENT'), `must not leak internals: ${message}`)
      assert.ok(!message.includes('stark:'), `must not leak channels: ${message}`)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})
