import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { createCapabilityBindings } from './capabilities'

function openHarness(): { db: DatabaseSync; bindings: ReturnType<typeof createCapabilityBindings>; service: CapabilityService } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const store = new CapabilityRepository(db)
  const service = new CapabilityService(store, workspaces)
  return { db, bindings: createCapabilityBindings(service), service }
}

describe('capability IPC bindings', () => {
  it('exposes exactly two capability channels', () => {
    const { db, bindings } = openHarness()
    try {
      assert.deepEqual(
        [...bindings.map((b) => b.channel)].sort(),
        [IPC_CHANNELS.capabilitiesGetWorkspaceConfig, IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig].sort()
      )
    } finally {
      db.close()
    }
  })

  it('get/update round-trips with safe errors and no authorize surface', async () => {
    const { db, bindings } = openHarness()
    try {
      const channels = bindings.map((b) => b.channel)
      assert.ok(!channels.some((c) => c.includes('authorize')))
      assert.ok(!channels.some((c) => c.includes('execute')))
      assert.ok(!channels.some((c) => c.includes('approve')))
      const get = bindings.find((b) => b.channel === IPC_CHANNELS.capabilitiesGetWorkspaceConfig)
      const update = bindings.find((b) => b.channel === IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig)
      assert.ok(get && update)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      const initial = (await get.invoke({ workspaceId: 1 }, undefined as never)) as { enabled: boolean }
      assert.equal(initial.enabled, false)
      const saved = (await update.invoke(
        {
          workspaceId: 1,
          enabled: true,
          policies: [
            { capability: 'workspace.read', mode: 'allow' },
            { capability: 'workspace.search', mode: 'ask' },
            { capability: 'git.read', mode: 'allow' },
            { capability: 'change.propose', mode: 'ask' },
            { capability: 'terminal.execute', mode: 'ask' },
            { capability: 'runtime.observe', mode: 'deny' },
            { capability: 'preview.inspect', mode: 'deny' }
          ]
        },
        undefined as never
      )) as { enabled: boolean }
      assert.equal(saved.enabled, true)
      await assert.rejects(update.invoke({ workspaceId: 1, enabled: true, policies: [] }, undefined as never))
    } finally {
      db.close()
    }
  })

  it('rejects unknown fields and terminal allow without internals', async () => {
    const { db, bindings } = openHarness()
    try {
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      const update = bindings.find((b) => b.channel === IPC_CHANNELS.capabilitiesUpdateWorkspaceConfig)
      assert.ok(update)
      await assert.rejects(
        update.invoke(
          {
            workspaceId: 1,
            enabled: true,
            policies: [
              { capability: 'workspace.read', mode: 'allow' },
              { capability: 'workspace.search', mode: 'allow' },
              { capability: 'git.read', mode: 'allow' },
              { capability: 'change.propose', mode: 'allow' },
              { capability: 'terminal.execute', mode: 'allow' }
            ]
          },
          undefined as never
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(!error.message.includes('sqlite'))
          assert.ok(!error.message.includes('stark:'))
          return true
        }
      )
    } finally {
      db.close()
    }
  })
})
