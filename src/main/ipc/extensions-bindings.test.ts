import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { IPC_CHANNELS } from '../../shared/constants'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import { ExtensionRegistryService } from '../extension-registry/extension-registry-service'
import { createExtensionsBindings } from './extensions'
import { createIpcBindings } from './index'

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

describe('extensions IPC bindings', () => {
  it('exposes exactly search and list-featured', () => {
    const bindings = createExtensionsBindings(new ExtensionRegistryService(async () => {
      throw new Error('network must not run in surface tests')
    }))
    assert.deepEqual(
      bindings.map((binding) => binding.channel).sort(),
      ['stark:extensions:list-featured', 'stark:extensions:search'].sort()
    )
  })

  it('full surface contains the catalog channels and no generic fetch channels', () => {
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
        extensionRegistryService: services.extensionRegistryService
      }).map((binding) => binding.channel)
      assert.ok(channels.includes(IPC_CHANNELS.extensionsSearch))
      assert.ok(channels.includes(IPC_CHANNELS.extensionsListFeatured))
      for (const forbidden of ['generic', 'fetch(', 'proxy', 'http', 'download', 'install', 'vsix', 'exec', 'shell']) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('validates search payload strictly with no URL parameter', async () => {
    const bindings = createExtensionsBindings(new ExtensionRegistryService(async () => {
      throw new Error('network must not run in validation tests')
    }))
    const search = bindings.find((binding) => binding.channel === 'stark:extensions:search')
    assert.ok(search !== undefined)
    for (const bad of [
      null,
      {},
      { query: '' },
      { query: '   ' },
      { query: 42 },
      { query: 'x'.repeat(101) },
      { query: 'theme', url: 'https://evil.example/' },
      { url: 'https://open-vsx.org/api/-/search?query=x' }
    ]) {
      await assert.rejects(search.invoke(bad), /Search text|We couldn’t load extensions\./)
    }
  })

  it('validates featured payload strictly', async () => {
    const bindings = createExtensionsBindings(new ExtensionRegistryService(async () => {
      throw new Error('network must not run in validation tests')
    }))
    const featured = bindings.find((binding) => binding.channel === 'stark:extensions:list-featured')
    assert.ok(featured !== undefined)
    for (const bad of [{ query: 'x' }, { url: 'https://evil.example/' }, 'x', 42]) {
      await assert.rejects(featured.invoke(bad), /We couldn’t load extensions\./)
    }
  })

  it('maps failures to public copy without internals', async () => {
    const bindings = createExtensionsBindings(
      new ExtensionRegistryService(async () => {
        throw new Error('socket hang up (internal detail)')
      })
    )
    const search = bindings.find((binding) => binding.channel === 'stark:extensions:search')
    assert.ok(search !== undefined)
    await assert.rejects(search.invoke({ query: 'theme' }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes('socket hang up'))
      assert.ok(!error.message.includes('open-vsx'))
      return true
    })
  })
})
