import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices, type ApplicationServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceService } from '../workspace/workspace-service'
import { createIpcBindings } from './index'
import { buildOpenDialogOptions, createWorkspaceBindings, type WorkspacePicker } from './workspace'
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
      changeTransactions: new ChangeTransactionRepository(db)
    })
  }
}

function openServicesWithClock(now: () => number): { db: DatabaseSync; service: WorkspaceService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, service: new WorkspaceService(new WorkspaceRepository(db), { now }) }
}

function makeTempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name))
}

function fakePicker(picked: string | undefined, seen: { parent: unknown; calls: number }): WorkspacePicker {
  return {
    pickDirectory: async (parentWindow) => {
      seen.calls += 1
      seen.parent = parentWindow === undefined ? 'undefined-explicit' : parentWindow
      return picked
    }
  }
}

const EXPECTED_CHANNELS: readonly IpcChannel[] = [
  'stark:workspace:choose-directory',
  'stark:workspace:get-current',
  'stark:workspace:list-recent',
  'stark:workspace:open'
]

describe('workspace IPC bindings', () => {
  it('exposes exactly the workspace channels and nothing else', () => {
    const { db, services } = openServices()
    try {
      const picker = fakePicker(undefined, { parent: null, calls: 0 })
      const channels = createWorkspaceBindings(services.workspaceService, picker).map(
        (binding) => binding.channel
      )
      assert.deepEqual([...channels].sort(), [...EXPECTED_CHANNELS].sort())
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        for (const forbidden of ['db:', 'sql:', 'filesystem:', 'dialog:', 'read', 'stat', 'open-path', 'set-path']) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains the workspace channels', () => {
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
    } finally {
      db.close()
    }
  })

  it('get-current and list-recent delegate to the service', async () => {
    const { db, services } = openServices()
    const dir = makeTempDir('stark-ws-ipc-')
    try {
      const picker = fakePicker(undefined, { parent: null, calls: 0 })
      const bindings = createWorkspaceBindings(services.workspaceService, picker)
      const getCurrent = bindings.find((binding) => binding.channel === 'stark:workspace:get-current')
      const listRecent = bindings.find((binding) => binding.channel === 'stark:workspace:list-recent')
      assert.ok(getCurrent !== undefined && listRecent !== undefined)
      assert.equal(await getCurrent.invoke(), null)
      assert.deepEqual(await listRecent.invoke(), [])
      const created = await services.workspaceService.openDirectory(dir)
      assert.deepEqual(await getCurrent.invoke(), created)
      assert.deepEqual(await listRecent.invoke(), [created])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('choose-directory cancellation touches nothing', async () => {
    const { db, services } = openServices()
    try {
      const seen = { parent: null as unknown, calls: 0 }
      const bindings = createWorkspaceBindings(services.workspaceService, fakePicker(undefined, seen))
      const choose = bindings.find((binding) => binding.channel === 'stark:workspace:choose-directory')
      assert.ok(choose !== undefined)
      assert.deepEqual(await choose.invoke(), { canceled: true })
      assert.equal(seen.calls, 1)
      assert.deepEqual(await services.workspaceService.listRecentWorkspaces(), [])
    } finally {
      db.close()
    }
  })

  it('choose-directory success delegates the picked path', async () => {
    const { db, services } = openServices()
    const dir = makeTempDir('stark-ws-pick-')
    try {
      const seen = { parent: null as unknown, calls: 0 }
      const bindings = createWorkspaceBindings(services.workspaceService, fakePicker(dir, seen))
      const choose = bindings.find((binding) => binding.channel === 'stark:workspace:choose-directory')
      assert.ok(choose !== undefined)
      const result = await choose.invoke()
      assert.equal(seen.calls, 1)
      assert.deepEqual(result, {
        canceled: false,
        workspace: await services.workspaceService.getCurrentWorkspace()
      })
      const workspace = (result as { workspace: { displayName: string } }).workspace
      assert.ok(workspace.displayName.length > 0)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('open-by-id delegates and rejects invalid ids safely', async () => {
    let now = 1000
    const { db, service } = openServicesWithClock(() => now)
    const dir = makeTempDir('stark-ws-open-')
    try {
      const created = await service.openDirectory(dir)
      now = 9000
      const picker = fakePicker(undefined, { parent: null, calls: 0 })
      const bindings = createWorkspaceBindings(service, picker)
      const open = bindings.find((binding) => binding.channel === 'stark:workspace:open')
      assert.ok(open !== undefined)
      const reopened = await open.invoke(created.id)
      assert.deepEqual(reopened, { ...created, lastOpenedAt: 9000 })
      for (const bad of ['1', Number.NaN, 0, -2, 1.5, {}, [1], null]) {
        await assert.rejects(
          open.invoke(bad),
          /We couldn’t open that project folder\.|That project folder is no longer available\./
        )
      }
      await assert.rejects(
        open.invoke(created.id + 999),
        /That project folder is no longer available\./
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('internal failures map without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const picker = fakePicker(undefined, { parent: null, calls: 0 })
      const bindings = createWorkspaceBindings(services.workspaceService, picker)
      db.exec('DROP TABLE workspaces')
      const getCurrent = bindings.find((binding) => binding.channel === 'stark:workspace:get-current')
      assert.ok(getCurrent !== undefined)
      await assert.rejects(getCurrent.invoke(), /We couldn’t load your workspaces\./)
    } finally {
      db.close()
    }
  })

  it('native dialog options request a single directory', () => {
    assert.deepEqual(buildOpenDialogOptions(), {
      title: 'Open project folder',
      buttonLabel: 'Open folder',
      properties: ['openDirectory']
    })
  })
})
