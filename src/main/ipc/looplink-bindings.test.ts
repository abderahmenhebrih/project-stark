import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { createIpcBindings } from './index'
import { createLooplinkBindings } from './looplink'

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const dir = mkdtempSync(join(tmpdir(), 'stark-looplink-ipc-'))
  return {
    db,
    dir,
    services: createServices({
      keyValue: new KeyValueRepository(db),
      workspaces: new WorkspaceRepository(db),
      changeTransactions: new ChangeTransactionRepository(db),
      changeSets: new ChangeSetRepository(db),
      orchestrationRuns: new OrchestrationRepository(db),
      looplinkStore: new LooplinkRepository(db),
      codingSessions: new CodingSessionRepository(db),
      aiProviders: new AiProviderRepository(db)
    })
  }
}

describe('looplink IPC bindings', () => {
  it('exposes exactly the three looplink channels', () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.looplinkService !== undefined)
      const channels = createLooplinkBindings(services.looplinkService).map((binding) => binding.channel)
      assert.deepEqual(
        [...channels].sort(),
        ['stark:looplink:create-continuation', 'stark:looplink:get-for-session', 'stark:looplink:dismiss'].sort()
      )
    } finally {
      db.close()
    }
  })

  it('full surface contains looplink channels and no payload setters', () => {
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
        aiCompletionService: services.aiCompletionService,
        aiCodeProposalService: services.aiCodeProposalService,
        aiMultiFileProposalService: services.aiMultiFileProposalService,
        changeSetService: services.changeSetService,
        aiBrainService: services.aiBrainService,
        heartService: services.heartService,
        looplinkService: services.looplinkService
      }).map((binding) => binding.channel)
      for (const expected of ['stark:looplink:create-continuation', 'stark:looplink:get-for-session', 'stark:looplink:dismiss']) {
        assert.ok((channels as readonly string[]).includes(expected), `missing ${expected}`)
      }
      for (const forbidden of ['looplink:payload', 'looplink:hash', 'payload-set', 'send-message', 'run-brain']) {
        for (const channel of channels) {
          if (channel.startsWith('stark:looplink:')) {
            continue
          }
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('validates looplink payloads strictly', async () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.looplinkService !== undefined)
      const bindings = createLooplinkBindings(services.looplinkService)
      const create = bindings.find((binding) => binding.channel === 'stark:looplink:create-continuation')
      const get = bindings.find((binding) => binding.channel === 'stark:looplink:get-for-session')
      const dismiss = bindings.find((binding) => binding.channel === 'stark:looplink:dismiss')
      assert.ok(create !== undefined && get !== undefined && dismiss !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 1 },
        { workspaceId: 1, sourceSessionId: '1' },
        { workspaceId: 1, sourceSessionId: 1, payload: '{}' },
        { workspaceId: 1, sourceSessionId: 1, targetSessionId: 2 },
        { workspaceId: 1, sourceSessionId: 1, messages: [] }
      ]) {
        await assert.rejects(create.invoke(bad), Error)
      }
      for (const bad of [null, {}, { workspaceId: 1 }, { workspaceId: 1, sessionId: '1' }, { workspaceId: 1, sessionId: 1, payload: '{}' }]) {
        await assert.rejects(get.invoke(bad), Error)
        await assert.rejects(dismiss.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('create-continuation end to end prepares a target without sending', async () => {
    const { db, dir, services } = openServices()
    try {
      const root = join(dir, 'project')
      mkdirSync(root, { recursive: true })
      const workspace = await services.workspaceService.openDirectory(root)
      const session = await services.codingSessionService.createSession({ workspaceId: workspace.id })
      await services.codingSessionService.sendUserMessage({
        workspaceId: workspace.id,
        sessionId: session.id,
        content: 'Source work.'
      })
      assert.ok(services.looplinkService !== undefined)
      const bindings = createLooplinkBindings(services.looplinkService)
      const create = bindings.find((binding) => binding.channel === 'stark:looplink:create-continuation')
      const get = bindings.find((binding) => binding.channel === 'stark:looplink:get-for-session')
      assert.ok(create !== undefined && get !== undefined)
      const result = (await create.invoke({ workspaceId: workspace.id, sourceSessionId: session.id })) as {
        targetSession: { id: number; title: string }
        looplink: { status: string }
      }
      assert.ok(result.targetSession.id !== session.id)
      assert.equal(result.looplink.status, 'pending')
      const preview = (await get.invoke({ workspaceId: workspace.id, sessionId: result.targetSession.id })) as {
        status: string
      } | null
      assert.equal(preview?.status, 'pending')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.looplinkService !== undefined)
      const bindings = createLooplinkBindings(services.looplinkService)
      const create = bindings.find((binding) => binding.channel === 'stark:looplink:create-continuation')
      assert.ok(create !== undefined)
      await assert.rejects(create.invoke({ workspaceId: 999999, sourceSessionId: 1 }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('sqlite'))
        assert.ok(!error.message.includes('stark:'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
