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
import { IPC_CHANNELS, type IpcChannel } from '../../shared/constants'
import { TerminalManager } from '../terminal/terminal-manager'
import { createIpcBindings } from './index'
import { createWorkspaceSearchBindings } from './workspace-search'

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
      changeTransactions: new ChangeTransactionRepository(db),
      codingSessions: new CodingSessionRepository(db),
      aiProviders: new AiProviderRepository(db),
    })
  }
}

function openFixture(): { db: DatabaseSync; services: ApplicationServices; dir: string; root: string } {
  const { db, services } = openServices()
  const dir = mkdtempSync(join(tmpdir(), 'stark-wsearch-ipc-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const authentication = true' + LF)
  writeFileSync(join(root, 'README.md'), '# Fixture' + LF)
  return { db, services, dir, root }
}

const EXPECTED_CHANNELS: readonly IpcChannel[] = ['stark:workspace-search:search']

describe('workspace-search IPC bindings', () => {
  it('exposes exactly one search channel and nothing else', () => {
    const { db, services } = openServices()
    try {
      const channels = createWorkspaceSearchBindings(services.workspaceSearchService).map((b) => b.channel)
      assert.deepEqual([...channels], [...EXPECTED_CHANNELS])
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        for (const forbidden of ['fs:', 'filesystem:', 'grep', 'ripgrep', 'exec', 'shell:', 'search:any-path', 'read-absolute']) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
      assert.equal(IPC_CHANNELS.workspaceSearch, 'stark:workspace-search:search')
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains the search channel alongside files channels', () => {
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
      }).map((b) => b.channel)
      assert.ok(channels.includes('stark:workspace-search:search'))
      assert.ok(channels.includes('stark:workspace-files:list-directory'))
      assert.ok(channels.includes('stark:workspace-files:read-text-file'))
      for (const channel of channels) {
        assert.ok(!channel.includes('ripgrep'))
        assert.ok(!channel.includes('exec'))
        assert.ok(!channel.startsWith('shell:'))
        assert.ok(!channel.startsWith('fs:'))
      }
    } finally {
      db.close()
    }
  })

  it('valid search delegates to the service', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createWorkspaceSearchBindings(fixture.services.workspaceSearchService)
      const search = bindings.find((b) => b.channel === 'stark:workspace-search:search')
      assert.ok(search !== undefined)
      const result = await search.invoke({ workspaceId: created.id, query: 'authentication' })
      assert.deepEqual(result, await fixture.services.workspaceSearchService.search({ workspaceId: created.id, query: 'authentication' }))
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('validates requests and rejects absolute roots at runtime', async () => {
    const fixture = openFixture()
    try {
      const created = await fixture.services.workspaceService.openDirectory(fixture.root)
      const bindings = createWorkspaceSearchBindings(fixture.services.workspaceSearchService)
      const search = bindings.find((b) => b.channel === 'stark:workspace-search:search')
      assert.ok(search !== undefined)
      for (const bad of [{ workspaceId: '1', query: 'a' }, { workspaceId: 0, query: 'a' }, { workspaceId: created.id, query: '' }, { workspaceId: created.id, query: '   ' }, { workspaceId: created.id, query: 'a'.repeat(257) }, { workspaceId: created.id, query: 42 }, { workspaceId: created.id, query: 'a', caseSensitive: 'yes' }, { workspaceId: created.id, query: 'a', rootPath: '/tmp' }]) {
        await assert.rejects(search.invoke(bad), /We couldn’t search this project\./)
      }
      await assert.rejects(
        search.invoke({ workspaceId: created.id, query: 'a', absoluteRoot: fixture.root }),
        /We couldn’t search this project\./
      )
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps internal failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createWorkspaceSearchBindings(services.workspaceSearchService)
      db.exec('DROP TABLE workspaces')
      const search = bindings.find((b) => b.channel === 'stark:workspace-search:search')
      assert.ok(search !== undefined)
      await assert.rejects(search.invoke({ workspaceId: 1, query: 'hello' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'We couldn’t search this project.')
        return true
      })
    } finally {
      db.close()
    }
  })
})
