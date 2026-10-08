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
import { createGitBindings } from './git'

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
      aiProviders: new AiProviderRepository(db),
    })
  }
}

describe('git IPC bindings', () => {
  it('exposes exactly get-status and get-diff', () => {
    const { db, services } = openServices()
    try {
      const bindings = createGitBindings(services.gitService)
      const channels = bindings.map((binding) => binding.channel).sort()
      assert.deepEqual(channels, ['stark:git:get-diff', 'stark:git:get-status'].sort())
    } finally {
      db.close()
    }
  })

  it('full surface contains git channels and no mutation/spawn channels', () => {
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
      assert.ok(channels.includes(IPC_CHANNELS.gitGetStatus))
      assert.ok(channels.includes(IPC_CHANNELS.gitGetDiff))
      for (const forbidden of [
        'git:run',
        'git:exec',
        'git:command',
        'git:stage',
        'git:commit',
        'git:checkout',
        'git:push',
        'git:pull',
        'git:fetch',
        'spawn',
        'exec',
        'shell'
      ]) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('validates get-status payload strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createGitBindings(services.gitService)
      const status = bindings.find((binding) => binding.channel === 'stark:git:get-status')
      assert.ok(status !== undefined)
      for (const bad of [null, {}, { workspaceId: '1' }, { workspaceId: 0 }, { workspaceId: 1, extra: 1 }, { cwd: '/tmp' }]) {
        await assert.rejects(status.invoke(bad), /We couldn’t read Git status\.|That project folder/)
      }
    } finally {
      db.close()
    }
  })

  it('validates get-diff payload strictly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-gitipc-'))
    const root = join(dir, 'project')
    mkdirSync(root, { recursive: true })
    const { db, services } = openServices()
    try {
      const created = await services.workspaceService.openDirectory(root)
      const bindings = createGitBindings(services.gitService)
      const diff = bindings.find((binding) => binding.channel === 'stark:git:get-diff')
      assert.ok(diff !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: created.id, relativePath: 'a.ts' },
        { workspaceId: created.id, relativePath: 'a.ts', target: 'cached' },
        { workspaceId: created.id, relativePath: '../evil.ts', target: 'staged' },
        { workspaceId: created.id, relativePath: '/abs.ts', target: 'staged' },
        { workspaceId: created.id, relativePath: 'a.ts', target: 'staged', extra: true },
        { workspaceId: created.id, relativePath: 'a.ts', target: 'staged', args: ['evil'] }
      ]) {
        await assert.rejects(diff.invoke(bad), /We couldn’t read this Git diff\.|untracked|Git is not available|No Git repository|inside a Git repository|project folder/)
      }
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps errors to public copy without internals', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createGitBindings(services.gitService)
      const status = bindings.find((binding) => binding.channel === 'stark:git:get-status')
      assert.ok(status !== undefined)
      await assert.rejects(status.invoke({ workspaceId: 999999 }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok(!error.message.includes('ENOENT'))
        assert.ok(!error.message.includes('stark:'))
        assert.ok(!error.message.includes('spawn'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
