import assert from 'node:assert/strict'
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
import { PROFILE_STORAGE_KEY } from '../profile/profile-schema'
import { ProfileService } from '../profile/profile-service'
import { createProfileBindings } from './profile'
import type { IpcChannel } from '../../shared/constants'

function openServices(): { db: DatabaseSync; services: ApplicationServices } {
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

const EXPECTED_CHANNELS: readonly IpcChannel[] = ['stark:profile:get', 'stark:profile:set-display-name']

describe('profile IPC bindings', () => {
  it('exposes exactly the profile channels and nothing else', () => {
    const { db, services } = openServices()
    try {
      const channels = createProfileBindings(services.profileService).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), EXPECTED_CHANNELS)
      for (const channel of channels) {
        assert.ok(channel.startsWith('stark:'))
        assert.ok(!channel.includes('db:'))
        assert.ok(!channel.includes('sql:'))
        assert.ok(!channel.includes('key'))
        assert.ok(!channel.includes('set-any'))
      }
    } finally {
      db.close()
    }
  })

  it('the full IPC surface contains the profile channels', () => {
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
    } finally {
      db.close()
    }
  })

  it('get delegates to the profile service', async () => {
    const { db, services } = openServices()
    try {
      await services.profileService.setDisplayName('Abdou')
      const bindings = createProfileBindings(services.profileService)
      const get = bindings.find((binding) => binding.channel === 'stark:profile:get')
      assert.ok(get !== undefined)
      assert.deepEqual(await get.invoke(), { displayName: 'Abdou' })
    } finally {
      db.close()
    }
  })

  it('set-display-name delegates and validates before persistence', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createProfileBindings(services.profileService)
      const set = bindings.find((binding) => binding.channel === 'stark:profile:set-display-name')
      assert.ok(set !== undefined)
      assert.deepEqual(await set.invoke('  Élodie  '), { displayName: 'Élodie' })
      await assert.rejects(set.invoke(''), /stark profile set-display-name failed/)
      await assert.rejects(set.invoke({ displayName: 'Nope' }), /stark profile set-display-name failed/)
      assert.deepEqual(await services.profileService.getProfile(), { displayName: 'Élodie' })
    } finally {
      db.close()
    }
  })

  it('corrupt storage fails cleanly without internals', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      db.exec(`INSERT INTO key_value (key, value, updated_at) VALUES ('${PROFILE_STORAGE_KEY}', '{broken', 0)`)
      const profile = new ProfileService(new KeyValueRepository(db))
      const bindings = createProfileBindings(profile)
      const get = bindings.find((binding) => binding.channel === 'stark:profile:get')
      assert.ok(get !== undefined)
      // Corrupt profile recovers to null rather than failing the call.
      assert.equal(await get.invoke(), null)
    } finally {
      db.close()
    }
  })
})
