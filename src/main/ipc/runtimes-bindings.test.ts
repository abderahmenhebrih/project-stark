import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityGate } from '../capabilities/capability-gate'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import { ProjectRuntimeService } from '../project-runtime/project-runtime-service'
import { createRuntimeBindings } from './runtimes'

function openHarness(): { db: DatabaseSync; dir: string; bindings: ReturnType<typeof createRuntimeBindings> } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const capStore = new CapabilityRepository(db)
  const runtimes = new ProjectRuntimeRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-runtime-ipc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  workspaces.create({ rootPath: root, displayName: 'p', now: 1 })
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const service = new ProjectRuntimeService({ workspaces, gate, runtimes })
  return { db, dir, bindings: createRuntimeBindings(service) }
}

describe('runtime IPC bindings', () => {
  it('exposes exactly five management channels and no spawn surface', () => {
    const { db, dir, bindings } = openHarness()
    try {
      assert.deepEqual(
        [...bindings.map((b) => b.channel)].sort(),
        [
          IPC_CHANNELS.runtimesGetActive,
          IPC_CHANNELS.runtimesListRecent,
          IPC_CHANNELS.runtimesStop,
          IPC_CHANNELS.runtimesOpenPreview,
          IPC_CHANNELS.runtimesReloadPreview
        ].sort()
      )
      const names = bindings.map((b) => b.channel).join(' ')
      assert.ok(!names.includes('start'))
      assert.ok(!names.includes('spawn'))
      assert.ok(!names.includes('execute'))
      assert.ok(!names.includes('kill'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads validate workspace scope with safe errors', async () => {
    const { db, dir, bindings } = openHarness()
    try {
      const get = bindings.find((b) => b.channel === IPC_CHANNELS.runtimesGetActive)
      assert.ok(get)
      assert.equal(await get.invoke({ workspaceId: 1 }, undefined as never), null)
      assert.deepEqual(await get.invoke({ workspaceId: 999 }, undefined as never).then(
        () => 'unexpected',
        (error: unknown) => (error as Error).message
      ), 'We couldn’t load the project runtime.')
      await assert.rejects(get.invoke({ workspaceId: 1, url: 'http://evil/' }, undefined as never))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop/open/reload carry IDs only and reject unknown runtimes safely', async () => {
    const { db, dir, bindings } = openHarness()
    try {
      const stop = bindings.find((b) => b.channel === IPC_CHANNELS.runtimesStop)
      const open = bindings.find((b) => b.channel === IPC_CHANNELS.runtimesOpenPreview)
      assert.ok(stop && open)
      // Renderer cannot smuggle program/args/URL/PID through these channels.
      await assert.rejects(stop.invoke({ workspaceId: 1, runtimeId: 1, program: 'evil' }, undefined as never))
      await assert.rejects(open.invoke({ workspaceId: 1, runtimeId: 1, url: 'http://evil:9999/' }, undefined as never))
      await assert.rejects(
        stop.invoke({ workspaceId: 1, runtimeId: 999 }, undefined as never),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(!error.message.includes('sqlite'))
          return true
        }
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
