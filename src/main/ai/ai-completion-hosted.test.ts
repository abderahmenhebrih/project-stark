import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { AiCompletionService } from './ai-completion-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderModelUnavailableError, StarkHostedSignInRequiredError } from './errors'
import type { AiProviderAdapter, HostedSessionProvider, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

/**
 * Hosted Ask proof (no network, no Supabase, no keys, no BYOK
 * credential). A `builtin:*` request model routes through the stark
 * adapter with the session token; legacy payloads keep the exact
 * persisted-BYOK behavior.
 */

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

class StarkFakeAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  seen: (ProviderGenerateRequest & { apiKey: string })[] = []
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'builtin:gpt-5.6-luna' }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.seen.push(request)
    return { text: 'hosted assistant reply' }
  }
}

function openHosted(session: HostedSessionProvider): {
  db: DatabaseSync
  completion: AiCompletionService
  adapter: StarkFakeAdapter
  workspaces: WorkspaceRepository
  sessions: CodingSessionRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const adapter = new StarkFakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: session
  })
  const completion = new AiCompletionService(workspaces, sessions, providerRows, providerService, registry)
  return { db, completion, adapter, workspaces, sessions }
}

async function openSession(harness: ReturnType<typeof openHosted>, rootPath: string): Promise<{ workspaceId: number; sessionId: number }> {
  const workspaceId = harness.workspaces.create({ rootPath, displayName: rootPath, now: 1000 }).id
  const sessionService = new CodingSessionService(harness.workspaces, harness.sessions)
  const session = await sessionService.createSession({ workspaceId })
  await sessionService.sendUserMessage({ workspaceId, sessionId: session.id, content: 'Hello STARK' })
  return { workspaceId, sessionId: session.id }
}

describe('hosted Ask routing', () => {
  it('answers a builtin request through stark with the session token and no BYOK key', async () => {
    const harness = openHosted({ getAccessToken: async () => 'ACCESS-MARKER' })
    try {
      const { workspaceId, sessionId } = await openSession(harness, 'w-hosted')
      const result = await harness.completion.generateResponse({ workspaceId, sessionId, model: 'builtin:gpt-5.6-luna' })
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'hosted assistant reply')
      assert.equal(harness.adapter.seen.length, 1)
      assert.equal(harness.adapter.seen[0]?.apiKey, 'ACCESS-MARKER')
      assert.equal(harness.adapter.seen[0]?.model, 'builtin:gpt-5.6-luna')
    } finally {
      harness.db.close()
    }
  })

  it('rejects unknown builtin ids without calling the adapter', async () => {
    const harness = openHosted({ getAccessToken: async () => 'ACCESS-MARKER' })
    try {
      const { workspaceId, sessionId } = await openSession(harness, 'w-hosted-bad')
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId, sessionId, model: 'builtin:evil' }),
        ProviderModelUnavailableError
      )
      assert.equal(harness.adapter.seen.length, 0)
    } finally {
      harness.db.close()
    }
  })

  it('maps signed-out sessions to sign-in-required', async () => {
    const harness = openHosted({
      getAccessToken: async () => {
        throw new StarkHostedSignInRequiredError()
      }
    })
    try {
      const { workspaceId, sessionId } = await openSession(harness, 'w-hosted-out')
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId, sessionId, model: 'builtin:gpt-5.6-luna' }),
        StarkHostedSignInRequiredError
      )
    } finally {
      harness.db.close()
    }
  })

  it('rejects malformed model selectors without calling the adapter', async () => {
    const harness = openHosted({ getAccessToken: async () => 'ACCESS-MARKER' })
    try {
      const { workspaceId, sessionId } = await openSession(harness, 'w-hosted-malformed')
      await assert.rejects(
        harness.completion.generateResponse({ workspaceId, sessionId, model: 'x'.repeat(129) }),
        /model reference is invalid/
      )
      assert.equal(harness.adapter.seen.length, 0)
    } finally {
      harness.db.close()
    }
  })
})
