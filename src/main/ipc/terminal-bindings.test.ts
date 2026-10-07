import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS, type IpcChannel } from '../../shared/constants'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceService } from '../workspace/workspace-service'
import { createServices } from '../application/create-services'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { TerminalService } from '../terminal/terminal-service'
import type { PtyFactory } from '../terminal/pty-adapter'
import { createIpcBindings } from './index'
import { createTerminalBindings } from './terminal'

const EXPECTED_TERMINAL_CHANNELS: readonly IpcChannel[] = [
  'stark:terminal:create',
  'stark:terminal:write',
  'stark:terminal:resize',
  'stark:terminal:kill'
]

const noopFactory: PtyFactory = {
  spawn: () => {
    throw new Error('pty spawn must not run in binding-shape tests')
  }
}

const noopSink = {
  sendData: () => {},
  sendExit: () => {}
}

function openTerminalStack(): {
  db: DatabaseSync
  service: TerminalService
  manager: TerminalManager
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  return { db, service: new TerminalService(workspaces), manager: new TerminalManager(noopFactory, noopSink) }
}

function fakeEvent(senderId: number): never {
  return { sender: { id: senderId, isDestroyed: () => false } } as never
}

/**
 * Stage 11 IPC surface: exactly four narrow invoke channels plus two
 * fixed main→renderer event channels. No generic shell/spawn/exec,
 * no child_process surface, strict sender validation, ownership, and
 * runtime payload validation.
 */
describe('terminal IPC bindings', () => {
  it('exposes exactly the four terminal invoke channels', () => {
    const { db, service, manager } = openTerminalStack()
    try {
      const channels = createTerminalBindings(service, manager).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_TERMINAL_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains terminal channels and fixed events', () => {
    const { db, service, manager } = openTerminalStack()
    try {
      const bindings = createTerminalBindings(service, manager)
      const channels = bindings.map((binding) => binding.channel)
      for (const expected of EXPECTED_TERMINAL_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      assert.equal(IPC_CHANNELS.terminalData, 'stark:terminal:data')
      assert.equal(IPC_CHANNELS.terminalExit, 'stark:terminal:exit')
      for (const channel of channels) {
        for (const forbidden of ['spawn-any', 'child_process', 'exec', 'spawn', ':pty', 'generic', ':shell']) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('create validates dimensions and resolves cwd through the service', async () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, migrations)
    const workspaces = new WorkspaceRepository(db)
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-ipc-'))
    try {
      const workspaceService = new WorkspaceService(workspaces)
      const created = await workspaceService.openDirectory(dir)
      let spawned = 0
      const factory: PtyFactory = {
        spawn: () => {
          spawned += 1
          return { onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }
        }
      }
      const service = new TerminalService(workspaces)
      const manager = new TerminalManager(factory, noopSink)
      const bindings = createTerminalBindings(service, manager)
      const create = bindings.find((binding) => binding.channel === 'stark:terminal:create')
      assert.ok(create !== undefined)
      const session = (await create.invoke(
        { workspaceId: created.id, cols: 80, rows: 24 },
        fakeEvent(701)
      )) as { id: string; workspaceId: number }
      assert.equal(session.workspaceId, created.id)
      assert.equal(spawned, 1)
      await assert.rejects(
        create.invoke({ workspaceId: created.id, cols: 5, rows: 24 }, fakeEvent(701)),
        /couldn’t start the terminal/
      )
      await assert.rejects(
        create.invoke({ workspaceId: 999999, cols: 80, rows: 24 }, fakeEvent(701)),
        /That project folder is no longer available/
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write/resize/kill enforce ownership and payload validation', async () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, migrations)
    const workspaces = new WorkspaceRepository(db)
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-own-'))
    try {
      const workspaceService = new WorkspaceService(workspaces)
      const created = await workspaceService.openDirectory(dir)
      const written: string[] = []
      const factory: PtyFactory = {
        spawn: () => ({
          onData: () => {},
          onExit: () => {},
          write: (data: string) => {
            written.push(data)
          },
          resize: () => {},
          kill: () => {}
        })
      }
      const service = new TerminalService(workspaces)
      const manager = new TerminalManager(factory, noopSink)
      const bindings = createTerminalBindings(service, manager)
      const byChannel = new Map(bindings.map((binding) => [binding.channel, binding]))
      const create = byChannel.get('stark:terminal:create')
      const write = byChannel.get('stark:terminal:write')
      assert.ok(create !== undefined && write !== undefined)
      const session = (await create.invoke({ workspaceId: created.id, cols: 80, rows: 24 }, fakeEvent(801))) as {
        id: string
      }
      await write.invoke({ sessionId: session.id, data: 'hi' }, fakeEvent(801))
      assert.deepEqual(written, ['hi'])
      await assert.rejects(write.invoke({ sessionId: session.id, data: 'hi' }, fakeEvent(802)), /no longer available/)
      await assert.rejects(
        write.invoke({ sessionId: 'bad-id', data: 'hi' }, fakeEvent(801)),
        /not accepted|no longer available/
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full surface helper includes terminal bindings when provided', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, migrations)
    try {
      const services = createServices({
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      })
      const manager = new TerminalManager(noopFactory, noopSink)
      const channels = createIpcBindings({
        settingsService: services.settingsService,
        profileService: services.profileService,
        workspaceService: services.workspaceService,
        workspaceFilesService: services.workspaceFilesService,
        workspaceFileWriteService: services.workspaceFileWriteService,
        workspaceSearchService: services.workspaceSearchService,
        changeTransactionService: services.changeTransactionService,
        terminalService: services.terminalService,
        terminalManager: manager,
        gitService: services.gitService,
        codingSessionService: services.codingSessionService,
        aiProviderService: services.aiProviderService,
        aiCompletionService: services.aiCompletionService
      }).map((binding) => binding.channel)
      for (const expected of EXPECTED_TERMINAL_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
    } finally {
      db.close()
    }
  })
})
