import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import type { CredentialProtector } from '../ai/credential-protector'
import { SecureStorageUnavailableError } from '../ai/errors'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createIpcBindings } from './index'
import { createProviderBindings } from './providers'
import { createAiBindings } from './ai'

class FakeProtector implements CredentialProtector {
  available = true

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async encrypt(secret: string): Promise<Buffer> {
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    return Buffer.from(`fake:${secret}`, 'utf8')
  }

  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    if (!this.available) {
      throw new SecureStorageUnavailableError()
    }
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  models: ProviderModel[] = [{ id: 'gpt-4o' }]
  listError: unknown = null

  async listModels(): Promise<readonly ProviderModel[]> {
    if (this.listError !== null) {
      throw this.listError
    }
    return this.models
  }

  async generateText(request: ProviderGenerateRequest & { readonly apiKey: string }): Promise<ProviderGenerateResult> {
    return { text: `echo:${request.messages[request.messages.length - 1]?.content ?? ''}` }
  }
}

function openServices(): {
  db: DatabaseSync
  services: ReturnType<typeof createServices>
  protector: FakeProtector
  adapter: FakeAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const protector = new FakeProtector()
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  return {
    db,
    protector,
    adapter,
    services: createServices(
      {
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      },
      {
        credentialProtector: protector,
        registry
      }
    )
  }
}

function fullSurface(services: ReturnType<typeof createServices>): string[] {
  const terminalManager = new TerminalManager(
    {
      spawn: () => {
        throw new Error('pty spawn must not run in surface tests')
      }
    },
    { sendData: () => {}, sendExit: () => {} }
  )
  return createIpcBindings({
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
}

const EXPECTED_PROVIDER_CHANNELS = [
  'stark:providers:get-state',
  'stark:providers:save-credential',
  'stark:providers:clear-credential',
  'stark:providers:test-connection',
  'stark:providers:list-models',
  'stark:providers:set-model'
] as const

describe('AI provider IPC bindings', () => {
  it('exposes exactly the six provider channels', () => {
    const { db, services } = openServices()
    try {
      const channels = createProviderBindings(services.aiProviderService).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), [...EXPECTED_PROVIDER_CHANNELS].sort())
    } finally {
      db.close()
    }
  })

  it('exposes exactly the one AI generation channel', () => {
    const { db, services } = openServices()
    try {
      const channels = createAiBindings(services.aiCompletionService).map((binding) => binding.channel)
      assert.deepEqual(channels, ['stark:ai:generate-response'])
    } finally {
      db.close()
    }
  })

  it('full surface contains provider/AI channels and no raw/secret channels', () => {
    const { db, services } = openServices()
    try {
      const channels = fullSurface(services)
      for (const expected of [...EXPECTED_PROVIDER_CHANNELS, 'stark:ai:generate-response']) {
        assert.ok(channels.includes(expected), `missing ${expected}`)
      }
      assert.ok(channels.includes(IPC_CHANNELS.providersGetState))
      for (const forbidden of [
        'provider:raw-request',
        'provider:fetch',
        'provider:set-base-url',
        'provider:set-header',
        'provider:get-api-key',
        'provider:decrypt',
        'provider:run',
        'get-key',
        'decrypt-key',
        'raw-provider-request',
        'set-base-url',
        'send-assistant',
        'tools',
        'run-agent',
        'fetch'
      ]) {
        for (const channel of channels) {
          assert.ok(!channel.includes(forbidden), `${channel} must not contain ${forbidden}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('save/get-state round-trips without ever returning the key', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createProviderBindings(services.aiProviderService)
      const save = bindings.find((binding) => binding.channel === 'stark:providers:save-credential')
      const get = bindings.find((binding) => binding.channel === 'stark:providers:get-state')
      assert.ok(save !== undefined && get !== undefined)
      const saved = (await save.invoke({ providerId: 'openai', apiKey: 'sk-live-key' })) as { configured: boolean }
      assert.equal(saved.configured, true)
      const state = (await get.invoke({ providerId: 'openai' })) as Record<string, unknown>
      assert.equal(state['configured'], true)
      assert.ok(!JSON.stringify(state).includes('sk-live-key'))
    } finally {
      db.close()
    }
  })

  it('validates provider payloads strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createProviderBindings(services.aiProviderService)
      const save = bindings.find((binding) => binding.channel === 'stark:providers:save-credential')
      const setModel = bindings.find((binding) => binding.channel === 'stark:providers:set-model')
      const get = bindings.find((binding) => binding.channel === 'stark:providers:get-state')
      assert.ok(save !== undefined && setModel !== undefined && get !== undefined)
      for (const bad of [null, {}, { providerId: 'anthropic' }, { providerId: 'openai', extra: 1 }]) {
        await assert.rejects(get.invoke(bad), Error)
      }
      for (const bad of [
        null,
        { providerId: 'openai' },
        { providerId: 'openai', apiKey: '' },
        { providerId: 'openai', apiKey: 'k', role: 'admin' }
      ]) {
        await assert.rejects(save.invoke(bad), Error)
      }
      for (const bad of [
        { providerId: 'openai', model: '' },
        { providerId: 'openai', model: 'https://x/y' },
        { providerId: 'openai', model: 'm', baseUrl: 'https://x' }
      ]) {
        await assert.rejects(setModel.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('generate-response validates session references strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createAiBindings(services.aiCompletionService)
      const generate = bindings.find((binding) => binding.channel === 'stark:ai:generate-response')
      assert.ok(generate !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 1 },
        { workspaceId: 1, sessionId: '1' },
        { workspaceId: 1, sessionId: 1, model: 'gpt-4o' },
        { workspaceId: 1, sessionId: 1, apiKey: 'sk-x' },
        { workspaceId: 1, sessionId: 1, messages: [] }
      ]) {
        await assert.rejects(generate.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('generate-response persists a real assistant message end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ai-ipc-'))
    const { db, services } = openServices()
    try {
      const root = join(dir, 'project')
      mkdirSync(root, { recursive: true })
      const workspace = await services.workspaceService.openDirectory(root)
      const session = await services.codingSessionService.createSession({ workspaceId: workspace.id })
      await services.codingSessionService.sendUserMessage({
        workspaceId: workspace.id,
        sessionId: session.id,
        content: 'Hello STARK'
      })
      const providerBindings = createProviderBindings(services.aiProviderService)
      const save = providerBindings.find((binding) => binding.channel === 'stark:providers:save-credential')
      const setModel = providerBindings.find((binding) => binding.channel === 'stark:providers:set-model')
      assert.ok(save !== undefined && setModel !== undefined)
      await save.invoke({ providerId: 'openai', apiKey: 'sk-test' })
      await setModel.invoke({ providerId: 'openai', model: 'gpt-4o' })
      const aiBindings = createAiBindings(services.aiCompletionService)
      const generate = aiBindings.find((binding) => binding.channel === 'stark:ai:generate-response')
      assert.ok(generate !== undefined)
      const result = (await generate.invoke({ workspaceId: workspace.id, sessionId: session.id })) as {
        message: { role: string; content: string }
      }
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'echo:Hello STARK')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps failures without secrets or internals', async () => {
    const { db, services, protector } = openServices()
    try {
      const bindings = createProviderBindings(services.aiProviderService)
      protector.available = false
      const save = bindings.find((binding) => binding.channel === 'stark:providers:save-credential')
      assert.ok(save !== undefined)
      await assert.rejects(save.invoke({ providerId: 'openai', apiKey: 'sk-x' }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Secure credential storage is not available on this system.')
        assert.ok(!error.message.includes('sk-x'))
        return true
      })
    } finally {
      db.close()
    }
  })
})
