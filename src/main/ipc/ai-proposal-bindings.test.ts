import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { createServices } from '../application/create-services'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createAiBindings } from './ai'

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
    return { outputText: JSON.stringify({ summary: 'bump', proposedContent: 'const a = 2\n' }) }
  }
}

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const protector = new FakeProtector()
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const dir = mkdtempSync(join(tmpdir(), 'stark-ai-propose-ipc-'))
  return {
    db,
    dir,
    services: createServices(
      {
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      },
      { credentialProtector: protector, registry }
    )
  }
}

describe('proposal IPC bindings', () => {
  it('exposes the fixed propose-file-change channel alongside generate-response', () => {
    const { db, services } = openServices()
    try {
      const channels = createAiBindings(services.aiCompletionService, services.aiCodeProposalService).map(
        (binding) => binding.channel
      )
      assert.deepEqual([...channels].sort(), ['stark:ai:generate-response', 'stark:ai:propose-file-change'].sort())
    } finally {
      db.close()
    }
  })

  it('omits the proposal channel when the service is absent', () => {
    const { db, services } = openServices()
    try {
      const channels = createAiBindings(services.aiCompletionService).map((binding) => binding.channel)
      assert.deepEqual(channels, ['stark:ai:generate-response'])
    } finally {
      db.close()
    }
  })

  it('propose-file-change validates session references strictly', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createAiBindings(services.aiCompletionService, services.aiCodeProposalService)
      const propose = bindings.find((binding) => binding.channel === 'stark:ai:propose-file-change')
      assert.ok(propose !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 1 },
        { workspaceId: 1, sessionId: '1' },
        { workspaceId: 1, sessionId: 1, relativePath: 'a.ts' },
        { workspaceId: 1, sessionId: 1, proposedContent: 'x' },
        { workspaceId: 1, sessionId: 1, model: 'gpt-4o' },
        { workspaceId: 1, sessionId: 1, expectedRevision: '0'.repeat(64) }
      ]) {
        await assert.rejects(propose.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('propose-file-change end to end creates a pending transaction without touching disk', async () => {
    const { db, dir, services } = openServices()
    try {
      const root = join(dir, 'project')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
      const workspace = await services.workspaceService.openDirectory(root)
      const session = await services.codingSessionService.createSession({ workspaceId: workspace.id })
      const whole = await services.sessionContextService.prepareWholeFile({ workspaceId: workspace.id, relativePath: 'app.ts' })
      await services.codingSessionService.sendUserMessage({
        workspaceId: workspace.id,
        sessionId: session.id,
        content: 'Bump it.',
        context: [whole]
      })
      await services.aiProviderService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await services.aiProviderService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const bindings = createAiBindings(services.aiCompletionService, services.aiCodeProposalService)
      const propose = bindings.find((binding) => binding.channel === 'stark:ai:propose-file-change')
      assert.ok(propose !== undefined)
      const result = (await propose.invoke({ workspaceId: workspace.id, sessionId: session.id })) as {
        transaction: { status: string; files: { proposedContent: string }[] }
        summary: string
      }
      assert.equal(result.transaction.status, 'pending')
      assert.equal(result.summary, 'bump')
      assert.equal(result.transaction.files[0]?.proposedContent, 'const a = 2\n')
      const { readFileSync } = await import('node:fs')
      assert.equal(readFileSync(join(root, 'app.ts'), 'utf8'), 'const a = 1\n')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps proposal failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      const bindings = createAiBindings(services.aiCompletionService, services.aiCodeProposalService)
      const propose = bindings.find((binding) => binding.channel === 'stark:ai:propose-file-change')
      assert.ok(propose !== undefined)
      await assert.rejects(propose.invoke({ workspaceId: 999999, sessionId: 1 }), (error: unknown) => {
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
