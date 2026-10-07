import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { createIpcBindings } from './index'
import { createSessionBindings } from './sessions'

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices> } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return {
    db,
    services: createServices({
      keyValue: new KeyValueRepository(db),
      workspaces: new WorkspaceRepository(db),
      changeTransactions: new ChangeTransactionRepository(db),
      codingSessions: new CodingSessionRepository(db),
      aiProviders: new AiProviderRepository(db)
    })
  }
}

function openFixture(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string; root: string } {
  const { db, services } = openServices()
  const dir = mkdtempSync(join(tmpdir(), 'stark-sessions-ipc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  return { db, services, dir, root }
}

const EXPECTED_CHANNELS = [
  'stark:sessions:create',
  'stark:sessions:list',
  'stark:sessions:list-messages',
  'stark:sessions:send-user-message'
] as const

describe('coding session IPC bindings', () => {
  it('exposes exactly the four session channels', () => {
    const { db, services } = openServices()
    try {
      const channels = createSessionBindings(services.codingSessionService).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('full surface contains session channels alongside provider/AI channels', () => {
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
        aiProviderService: services.aiProviderService,
        aiCompletionService: services.aiCompletionService
      }).map((binding) => binding.channel)
      for (const expected of EXPECTED_CHANNELS) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      assert.ok(channels.includes(IPC_CHANNELS.sessionsCreate))
      assert.ok(channels.includes(IPC_CHANNELS.providersGetState))
      assert.ok(channels.includes(IPC_CHANNELS.aiGenerateResponse))
      for (const forbidden of [
        'session:sql',
        'message:insert-any-role',
        'send-assistant',
        'chat:run',
        'model:complete',
        'generic storage',
        'fetch',
        'sqlite'
      ]) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('create delegates to the service and round-trips', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const create = bindings.find((binding) => binding.channel === 'stark:sessions:create')
      assert.ok(create !== undefined)
      const session = (await create.invoke({ workspaceId: created.id })) as { id: number; title: string }
      assert.equal(session.title, 'New session')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('list delegates to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const list = bindings.find((binding) => binding.channel === 'stark:sessions:list')
      assert.ok(list !== undefined)
      assert.deepEqual(await list.invoke({ workspaceId: created.id }), [])
      await fixture.services.codingSessionService.createSession({ workspaceId: created.id })
      assert.equal(((await list.invoke({ workspaceId: created.id })) as unknown[]).length, 1)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('send-user-message persists and returns session plus message', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const create = bindings.find((binding) => binding.channel === 'stark:sessions:create')
      const send = bindings.find((binding) => binding.channel === 'stark:sessions:send-user-message')
      assert.ok(create !== undefined && send !== undefined)
      const session = (await create.invoke({ workspaceId: created.id })) as { id: number }
      const result = (await send.invoke({
        workspaceId: created.id,
        sessionId: session.id,
        content: 'Hello STARK'
      })) as { session: { title: string }; message: { role: string; content: string } }
      assert.equal(result.message.role, 'user')
      assert.equal(result.message.content, 'Hello STARK')
      assert.equal(result.session.title, 'Hello STARK')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates create/list payloads strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createSessionBindings(services.codingSessionService)
      const create = bindings.find((binding) => binding.channel === 'stark:sessions:create')
      const list = bindings.find((binding) => binding.channel === 'stark:sessions:list')
      assert.ok(create !== undefined && list !== undefined)
      for (const bad of [null, {}, { workspaceId: '1' }, { workspaceId: 0 }, { workspaceId: 1.5 }, { workspaceId: 1, extra: 1 }]) {
        await assert.rejects(create.invoke(bad), /We couldn’t create this session\.|That project folder/)
        await assert.rejects(list.invoke(bad), /We couldn’t load your sessions\.|That project folder/)
      }
    } finally {
      db.close()
    }
  })

  it('validates list-messages payloads strictly', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const listMessages = bindings.find((binding) => binding.channel === 'stark:sessions:list-messages')
      assert.ok(listMessages !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: created.id },
        { workspaceId: created.id, sessionId: '1' },
        { workspaceId: created.id, sessionId: 1, beforeMessageId: 0 },
        { workspaceId: created.id, sessionId: 1, beforeMessageId: '2' },
        { workspaceId: created.id, sessionId: 1, extra: true }
      ]) {
        await assert.rejects(
          listMessages.invoke(bad),
          /We couldn’t load these messages\.|That session is no longer available\.|That project folder/
        )
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates send payloads strictly, including content', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const session = await fixture.services.codingSessionService.createSession({ workspaceId: created.id })
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const send = bindings.find((binding) => binding.channel === 'stark:sessions:send-user-message')
      assert.ok(send !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: created.id, sessionId: session.id },
        { workspaceId: created.id, sessionId: session.id, content: '' },
        { workspaceId: created.id, sessionId: session.id, content: '   ' },
        { workspaceId: created.id, sessionId: session.id, content: 42 },
        { workspaceId: created.id, sessionId: session.id, content: 'hi', role: 'assistant' },
        { workspaceId: created.id, sessionId: session.id, content: 'hi', extra: true }
      ]) {
        await assert.rejects(
          send.invoke(bad),
          /We couldn’t save this message\.|This message is too large\.|That session is no longer available\./
        )
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps workspace/session mismatch safely', async () => {
    const fixture = openFixture()
    try {
      const first = await fixture.services.workspaceService.openDirectory(fixture.root)
      const otherRoot = join(fixture.dir, 'other')
      mkdirSync(otherRoot, { recursive: true })
      const second = await fixture.services.workspaceService.openDirectory(otherRoot)
      const session = await fixture.services.codingSessionService.createSession({ workspaceId: first.id })
      const bindings = createSessionBindings(fixture.services.codingSessionService)
      const send = bindings.find((binding) => binding.channel === 'stark:sessions:send-user-message')
      const listMessages = bindings.find((binding) => binding.channel === 'stark:sessions:list-messages')
      assert.ok(send !== undefined && listMessages !== undefined)
      await assert.rejects(
        send.invoke({ workspaceId: second.id, sessionId: session.id, content: 'hi' }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'That session is no longer available.')
          assert.ok(!error.message.includes('stark:'))
          return true
        }
      )
      await assert.rejects(listMessages.invoke({ workspaceId: second.id, sessionId: session.id }), /That session is no longer available\./)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps internal failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createSessionBindings(services.codingSessionService)
      db.exec('DROP TABLE coding_sessions')
      const list = bindings.find((binding) => binding.channel === 'stark:sessions:list')
      assert.ok(list !== undefined)
      await assert.rejects(list.invoke({ workspaceId: 1 }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('sqlite'))
        assert.ok(!error.message.includes('coding_sessions'))
        assert.ok(!error.message.includes('stark:'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
