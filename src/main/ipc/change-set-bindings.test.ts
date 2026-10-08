import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { TerminalManager } from '../terminal/terminal-manager'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createIpcBindings } from './index'
import { createAiBindings } from './ai'
import { createChangeSetBindings } from './change-sets'

class FakeProtector implements CredentialProtector {
  async isAvailable(): Promise<boolean> {
    return true
  }
  async encrypt(secret: string): Promise<Buffer> {
    return Buffer.from(`fake:${secret}`, 'utf8')
  }
  async decrypt(ciphertext: Buffer): Promise<{ secret: string; shouldReEncrypt: boolean }> {
    return { secret: ciphertext.toString('utf8').replace(/^fake:/, ''), shouldReEncrypt: false }
  }
}

class FakeAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }

  async generateStructured(): Promise<ProviderStructuredResult> {
    return {
      outputText: JSON.stringify({
        summary: 'grouped',
        changes: [
          { targetId: 'T1', summary: 'bump a', proposedContent: 'const a = 2\n' },
          { targetId: 'T2', summary: 'bump b', proposedContent: 'const b = 2\n' }
        ]
      })
    }
  }
}

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const protector = new FakeProtector()
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const dir = mkdtempSync(join(tmpdir(), 'stark-changeset-ipc-'))
  return {
    db,
    dir,
    services: createServices(
      {
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        changeSets: new ChangeSetRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      },
      { credentialProtector: protector, registry }
    )
  }
}

describe('change set IPC bindings', () => {
  it('exposes exactly the two change-set read channels', () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.changeSetService !== undefined)
      assert.ok(services.aiMultiFileProposalService !== undefined)
      const channels = createChangeSetBindings(services.changeSetService).map((binding) => binding.channel)
      assert.deepEqual([...channels].sort(), ['stark:change-sets:get', 'stark:change-sets:list-recent'].sort())
    } finally {
      db.close()
    }
  })

  it('exposes the propose-change-set channel', () => {
    const { db, services } = openServices()
    try {
      const channels = createAiBindings(
        services.aiCompletionService,
        services.aiCodeProposalService,
        services.aiMultiFileProposalService
      ).map((binding) => binding.channel)
      assert.deepEqual(
        [...channels].sort(),
        ['stark:ai:generate-response', 'stark:ai:propose-file-change', 'stark:ai:propose-change-set'].sort()
      )
    } finally {
      db.close()
    }
  })

  it('full surface contains change-set channels and no mutation channel', () => {
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
        changeSetService: services.changeSetService
      }).map((binding) => binding.channel)
      assert.ok(channels.includes('stark:change-sets:get'))
      assert.ok(channels.includes('stark:change-sets:list-recent'))
      assert.ok(channels.includes('stark:ai:propose-change-set'))
      for (const channel of channels) {
        assert.ok(!channel.includes('accept-all'), `${channel} must not contain accept-all`)
      }
    } finally {
      db.close()
    }
  })

  it('validates change-set payloads strictly', async () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.changeSetService !== undefined)
      const bindings = createChangeSetBindings(services.changeSetService)
      const get = bindings.find((binding) => binding.channel === 'stark:change-sets:get')
      const list = bindings.find((binding) => binding.channel === 'stark:change-sets:list-recent')
      assert.ok(get !== undefined && list !== undefined)
      for (const bad of [null, {}, { changeSetId: '1' }, { changeSetId: 1, extra: true }]) {
        await assert.rejects(get.invoke(bad), Error)
      }
      for (const bad of [null, {}, { workspaceId: '1' }, { workspaceId: 1, extra: true }]) {
        await assert.rejects(list.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('propose-change-set validates session references strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createAiBindings(
        services.aiCompletionService,
        services.aiCodeProposalService,
        services.aiMultiFileProposalService
      )
      const propose = bindings.find((binding) => binding.channel === 'stark:ai:propose-change-set')
      assert.ok(propose !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 1 },
        { workspaceId: 1, sessionId: '1' },
        { workspaceId: 1, sessionId: 1, targetIds: ['T1'] },
        { workspaceId: 1, sessionId: 1, relativePaths: ['a.ts'] },
        { workspaceId: 1, sessionId: 1, model: 'gpt-4o' }
      ]) {
        await assert.rejects(propose.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('propose-change-set end to end persists a set without touching disk', async () => {
    const { db, dir, services } = openServices()
    try {
      const root = join(dir, 'project')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
      writeFileSync(join(root, 'b.ts'), 'const b = 1\n')
      const workspace = await services.workspaceService.openDirectory(root)
      const session = await services.codingSessionService.createSession({ workspaceId: workspace.id })
      const first = await services.sessionContextService.prepareWholeFile({ workspaceId: workspace.id, relativePath: 'a.ts' })
      const second = await services.sessionContextService.prepareWholeFile({ workspaceId: workspace.id, relativePath: 'b.ts' })
      await services.codingSessionService.sendUserMessage({
        workspaceId: workspace.id,
        sessionId: session.id,
        content: 'Bump both.',
        context: [first, second]
      })
      await services.aiProviderService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await services.aiProviderService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const bindings = createAiBindings(
        services.aiCompletionService,
        services.aiCodeProposalService,
        services.aiMultiFileProposalService
      )
      const propose = bindings.find((binding) => binding.channel === 'stark:ai:propose-change-set')
      assert.ok(propose !== undefined)
      const result = (await propose.invoke({ workspaceId: workspace.id, sessionId: session.id })) as {
        changeSet: { id: number; items: { transaction: { status: string } }[] }
      }
      assert.equal(result.changeSet.items.length, 2)
      for (const item of result.changeSet.items) {
        assert.equal(item.transaction.status, 'pending')
      }
      assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'const a = 1\n')
      assert.equal(readFileSync(join(root, 'b.ts'), 'utf8'), 'const b = 1\n')
      assert.ok(services.changeSetService !== undefined)
      const listBindings = createChangeSetBindings(services.changeSetService)
      const list = listBindings.find((binding) => binding.channel === 'stark:change-sets:list-recent')
      assert.ok(list !== undefined)
      const sets = (await list.invoke({ workspaceId: workspace.id })) as unknown[]
      assert.equal(sets.length, 1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
