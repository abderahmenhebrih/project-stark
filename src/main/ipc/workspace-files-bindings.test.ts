import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices, type ApplicationServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { createIpcBindings } from './index'
import { createWorkspaceFilesBindings } from './workspace-files'
import type { IpcChannel } from '../../shared/constants'

function openServices(): { db: DatabaseSync; services: ApplicationServices } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const keyValue = new KeyValueRepository(db)
  return {
    db,
    services: createServices({
      keyValue,
      workspaces: new WorkspaceRepository(db),
      changeTransactions: new ChangeTransactionRepository(db),
      codingSessions: new CodingSessionRepository(db),
      aiProviders: new AiProviderRepository(db),
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-wsfipc-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true\n')
  writeFileSync(join(root, 'README.md'), '# Fixture\n')
  return { db, services, dir, root }
}

const EXPECTED_CHANNELS: readonly IpcChannel[] = [
  'stark:workspace-files:list-directory',
  'stark:workspace-files:read-text-file',
  'stark:workspace-files:write-text-file'
]

function filesBindings(services: ApplicationServices): ReturnType<typeof createWorkspaceFilesBindings> {
  return createWorkspaceFilesBindings(services.workspaceFilesService, services.workspaceFileWriteService)
}

describe('workspace-files IPC bindings', () => {
  it('exposes exactly the files channels and nothing else', () => {
    const { db, services } = openServices()
    try {
      const channels = filesBindings(services).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_CHANNELS].sort())
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        for (const forbidden of [
          'fs:',
          'filesystem:',
          'read-absolute',
          'write-path',
          'write-absolute',
          'save-as',
          'db:',
          'sql:',
          'dialog:'
        ]) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
      for (const forbidden of ['writeFile', 'rename', 'unlink', 'chmod', 'invoke', 'send']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains the files channels', () => {
    const { db, services } = openServices()
    try {
      const terminalManager = new TerminalManager(
        {
          spawn: () => {
            throw new Error('pty spawn must not run in surface tests')
          }
        },
        { sendData: () => {}, sendExit: () => {} }
      )
      const channels = createIpcBindings({
        settingsService: services.settingsService,
        profileService: services.profileService,
        workspaceService: services.workspaceService,
        workspaceFilesService: services.workspaceFilesService,
        workspaceFileWriteService: services.workspaceFileWriteService,
        workspaceSearchService: services.workspaceSearchService,
        changeTransactionService: services.changeTransactionService,
        terminalService: services.terminalService,
        terminalManager,
        gitService: services.gitService,
        codingSessionService: services.codingSessionService,
        sessionContextService: services.sessionContextService,
        aiProviderService: services.aiProviderService,
        aiCompletionService: services.aiCompletionService
      }).map((binding) => binding.channel)
      for (const expected of EXPECTED_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      for (const channel of channels) {
        assert.ok(!channel.includes('save-as'), 'no save-as channel may exist')
        assert.ok(!channel.includes('write-path'), 'no generic write channel may exist')
      }
    } finally {
      db.close()
    }
  })

  it('list-directory delegates to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const list = bindings.find((binding) => binding.channel === 'stark:workspace-files:list-directory')
      assert.ok(list !== undefined)
      const listing = await list.invoke({ workspaceId: created.id, relativePath: '' })
      assert.deepEqual(listing, await fixture.services.workspaceFilesService.listDirectory({
        workspaceId: created.id,
        relativePath: ''
      }))
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('read-text-file delegates to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const read = bindings.find((binding) => binding.channel === 'stark:workspace-files:read-text-file')
      assert.ok(read !== undefined)
      const file = await read.invoke({ workspaceId: created.id, relativePath: 'src/index.ts' })
      const expected = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/index.ts'
      })
      assert.deepEqual(file, expected)
      assert.equal(file.content, 'export const ok = true\n')
      assert.equal(file.size, 23)
      assert.match(file.revision, /^[0-9a-f]{64}$/)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('write-text-file delegates to the write service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const write = bindings.find((binding) => binding.channel === 'stark:workspace-files:write-text-file')
      assert.ok(write !== undefined)
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/index.ts'
      })
      const result = (await write.invoke({
        workspaceId: created.id,
        relativePath: 'src/index.ts',
        expectedRevision: before.revision,
        content: 'export const changed = true\n'
      })) as { workspaceId: number; relativePath: string; size: number; changed: boolean; revision: string }
      // The binding delegates to the write service: same request through
      // the service layer must report identical bytes as unchanged.
      const again = await fixture.services.workspaceFileWriteService.writeTextFile({
        workspaceId: created.id,
        relativePath: 'src/index.ts',
        expectedRevision: result.revision,
        content: 'export const changed = true\n'
      })
      assert.equal(result.changed, true)
      assert.match(result.revision, /^[0-9a-f]{64}$/)
      assert.deepEqual(again, { ...result, changed: false })
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps write failures to safe public copy', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const write = bindings.find((binding) => binding.channel === 'stark:workspace-files:write-text-file')
      assert.ok(write !== undefined)
      const before = await fixture.services.workspaceFilesService.readTextFile({
        workspaceId: created.id,
        relativePath: 'src/index.ts'
      })
      await assert.rejects(
        write.invoke({
          workspaceId: created.id,
          relativePath: 'src/index.ts',
          expectedRevision: '0'.repeat(64),
          content: 'stale\n'
        }),
        /This file changed on disk\. Reload it before saving your changes\./
      )
      await assert.rejects(
        write.invoke({
          workspaceId: created.id,
          relativePath: 'src/index.ts',
          expectedRevision: before.revision,
          content: 'x'.repeat(1024 * 1024 + 1)
        }),
        /This file is too large to save\./
      )
      await assert.rejects(
        write.invoke({
          workspaceId: created.id,
          relativePath: 'src/index.ts',
          expectedRevision: before.revision,
          content: 'bad' + String.fromCharCode(0)
        }),
        /This file isn’t a supported text file\./
      )
      await assert.rejects(
        write.invoke({
          workspaceId: created.id,
          relativePath: '/abs/path.txt',
          expectedRevision: before.revision,
          content: 'x\n'
        }),
        /We couldn’t save this file\./
      )
      for (const bad of [null, 'x', 42, {}, { workspaceId: created.id }]) {
        await assert.rejects(write.invoke(bad), /We couldn’t save this file\./)
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates workspace ids and relative paths at runtime', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const list = bindings.find((binding) => binding.channel === 'stark:workspace-files:list-directory')
      const read = bindings.find((binding) => binding.channel === 'stark:workspace-files:read-text-file')
      assert.ok(list !== undefined && read !== undefined)
      for (const badId of ['1', 0, -2, 1.5, Number.NaN, null]) {
        await assert.rejects(
          list.invoke({ workspaceId: badId, relativePath: '' }),
          /We couldn’t read this folder\./
        )
      }
      for (const badPath of ['../..', '/abs', 42, null]) {
        await assert.rejects(
          list.invoke({ workspaceId: created.id, relativePath: badPath }),
          /We couldn’t read this folder\./
        )
        await assert.rejects(
          read.invoke({ workspaceId: created.id, relativePath: badPath }),
          /We couldn’t read this file\.|That project folder is no longer available\./
        )
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('rejects absolute host paths', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = filesBindings(fixture.services)
      const read = bindings.find((binding) => binding.channel === 'stark:workspace-files:read-text-file')
      const write = bindings.find((binding) => binding.channel === 'stark:workspace-files:write-text-file')
      assert.ok(read !== undefined && write !== undefined)
      await assert.rejects(
        read.invoke({ workspaceId: created.id, relativePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }),
        /We couldn’t read this file\./
      )
      await assert.rejects(
        write.invoke({
          workspaceId: created.id,
          relativePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
          expectedRevision: '0'.repeat(64),
          content: 'x\n'
        }),
        /We couldn’t save this file\./
      )
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps internal failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const bindings = filesBindings(services)
      db.exec('DROP TABLE workspaces')
      const list = bindings.find((binding) => binding.channel === 'stark:workspace-files:list-directory')
      assert.ok(list !== undefined)
      await assert.rejects(list.invoke({ workspaceId: 1, relativePath: '' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'We couldn’t read this folder.')
        return true
      })
    } finally {
      db.close()
    }
  })
})
