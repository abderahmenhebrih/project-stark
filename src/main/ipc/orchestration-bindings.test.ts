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
import { HeartRepository } from '../heart/heart-repository'
import { KeyValueRepository } from '../database/repositories/key-value-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { createOrchestrationBindings } from './orchestration'

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
    return { text: 'final' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    return {
      outputText: JSON.stringify({ action: 'answer', planSummary: 'Direct.', finalAnswer: 'DIRECT_OK', workerInstruction: null, workerProfile: null })
    }
  }
}

function openServices(): { db: DatabaseSync; services: ReturnType<typeof createServices>; dir: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-ipc-'))
  return {
    db,
    dir,
    services: createServices(
      {
        keyValue: new KeyValueRepository(db),
        workspaces: new WorkspaceRepository(db),
        changeTransactions: new ChangeTransactionRepository(db),
        changeSets: new ChangeSetRepository(db),
        orchestrationRuns: new OrchestrationRepository(db),
        heartStore: new HeartRepository(db),
        codingSessions: new CodingSessionRepository(db),
        aiProviders: new AiProviderRepository(db)
      },
      { credentialProtector: new FakeProtector(), registry }
    )
  }
}

describe('orchestration IPC bindings', () => {
  it('exposes exactly the three orchestration channels', () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.aiBrainService !== undefined)
      const channels = createOrchestrationBindings(services.aiBrainService).map((binding) => binding.channel)
      assert.deepEqual(
        [...channels].sort(),
        ['stark:ai:run-brain', 'stark:orchestration:get', 'stark:orchestration:list-recent'].sort()
      )
    } finally {
      db.close()
    }
  })

  it('validates run-brain payloads strictly', async () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.aiBrainService !== undefined)
      const bindings = createOrchestrationBindings(services.aiBrainService)
      const run = bindings.find((binding) => binding.channel === 'stark:ai:run-brain')
      assert.ok(run !== undefined)
      for (const bad of [
        null,
        {},
        { workspaceId: 1 },
        { workspaceId: 1, sessionId: '1' },
        { workspaceId: 1, sessionId: 1, model: 'gpt-4o' },
        { workspaceId: 1, sessionId: 1, prompt: 'hi' },
        { workspaceId: 1, sessionId: 1, messageId: 2 }
      ]) {
        await assert.rejects(run.invoke(bad), Error)
      }
    } finally {
      db.close()
    }
  })

  it('run-brain end to end persists a completed run and assistant message', async () => {
    const { db, dir, services } = openServices()
    try {
      const root = join(dir, 'project')
      mkdirSync(root, { recursive: true })
      const workspace = await services.workspaceService.openDirectory(root)
      const session = await services.codingSessionService.createSession({ workspaceId: workspace.id })
      await services.codingSessionService.sendUserMessage({
        workspaceId: workspace.id,
        sessionId: session.id,
        content: 'Hello brain.'
      })
      await services.aiProviderService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await services.aiProviderService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      assert.ok(services.aiBrainService !== undefined)
      const bindings = createOrchestrationBindings(services.aiBrainService)
      const run = bindings.find((binding) => binding.channel === 'stark:ai:run-brain')
      assert.ok(run !== undefined)
      const raw = (await run.invoke({ workspaceId: workspace.id, sessionId: session.id })) as {
        kind?: string
        result?: { run: { status: string; action: string }; message: { role: string; content: string } }
        run?: { status: string; action: string }
        message?: { role: string; content: string }
      }
      // Stage 21 returns a discriminated result; older harnesses without
      // a coordinator receive the completed wrapper.
      const result = raw.kind === 'completed' && raw.result !== undefined ? raw.result : raw as {
        run: { status: string; action: string }
        message: { role: string; content: string }
      }
      assert.equal(result.run.status, 'completed')
      assert.equal(result.run.action, 'answer')
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'DIRECT_OK')
      const get = bindings.find((binding) => binding.channel === 'stark:orchestration:get')
      assert.ok(get !== undefined)
      const list = bindings.find((binding) => binding.channel === 'stark:orchestration:list-recent')
      assert.ok(list !== undefined)
      const sets = (await list.invoke({ workspaceId: workspace.id, sessionId: session.id })) as unknown[]
      assert.equal(sets.length, 1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps failures without implementation details', async () => {
    const { db, services } = openServices()
    try {
      assert.ok(services.aiBrainService !== undefined)
      const bindings = createOrchestrationBindings(services.aiBrainService)
      const run = bindings.find((binding) => binding.channel === 'stark:ai:run-brain')
      assert.ok(run !== undefined)
      await assert.rejects(run.invoke({ workspaceId: 999999, sessionId: 1 }), (error: unknown) => {
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
