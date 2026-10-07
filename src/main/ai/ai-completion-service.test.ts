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
import {
  GenerationInFlightError,
  NothingToAnswerError,
  ProviderCredentialMissingError,
  ProviderEmptyResponseError,
  ProviderGenericError,
  ProviderModelMissingError
} from './errors'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { MAX_AI_CONTEXT_BYTES, MAX_AI_CONTEXT_MESSAGES } from './limits'

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
  generateError: unknown = null
  generateCalls = 0
  seen: (ProviderGenerateRequest & { apiKey: string })[] = []
  nextText = 'real assistant reply'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.generateCalls += 1
    this.seen.push(request)
    if (this.generateError !== null) {
      throw this.generateError
    }
    return { text: this.nextText }
  }
}

function openCompletion(clock?: () => number): {
  db: DatabaseSync
  completion: AiCompletionService
  adapter: FakeAdapter
  workspaces: WorkspaceRepository
  sessions: CodingSessionRepository
  providerService: AiProviderService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const adapter = new FakeAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const completion = new AiCompletionService(
    workspaces,
    sessions,
    providerRows,
    providerService,
    registry,
    clock === undefined ? undefined : { now: clock }
  )
  return { db, completion, adapter, workspaces, sessions, providerService }
}

async function openConfiguredSession(
  harness: ReturnType<typeof openCompletion>,
  rootPath: string,
  userContent = 'Hello STARK'
): Promise<{ workspaceId: number; sessionId: number }> {
  const workspaceId = harness.workspaces.create({ rootPath, displayName: rootPath, now: 1000 }).id
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const sessionService = new CodingSessionService(harness.workspaces, harness.sessions)
  const session = await sessionService.createSession({ workspaceId })
  await sessionService.sendUserMessage({ workspaceId, sessionId: session.id, content: userContent })
  return { workspaceId, sessionId: session.id }
}

describe('AI completion service', () => {
  it('persists a real assistant message for a trailing user message', async () => {
    const harness = openCompletion(() => 9000)
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'real assistant reply')
      assert.equal(result.message.sessionId, sessionId)
      assert.equal(result.session.updatedAt, 9000)
      const stored = harness.sessions.findMessageById(result.message.id)
      assert.equal(stored?.role, 'assistant')
    } finally {
      harness.db.close()
    }
  })

  it('forces the assistant role through the main-only path', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      harness.adapter.nextText = 'forced-role reply'
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.message.role, 'assistant')
    } finally {
      harness.db.close()
    }
  })

  it('rejects workspace/session mismatch', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'a')
      const other = harness.workspaces.create({ rootPath: 'b', displayName: 'b', now: 1000 }).id
      await assert.rejects(harness.completion.generateResponse({ workspaceId: other, sessionId }), /That session is no longer available\./)
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId: 9999 }), /That session is no longer available\./)
      await assert.rejects(harness.completion.generateResponse({ workspaceId: 9999, sessionId }), /That project folder is no longer available\./)
    } finally {
      harness.db.close()
    }
  })

  it('requires a stored credential', async () => {
    const harness = openCompletion()
    try {
      const workspaceId = harness.workspaces.create({ rootPath: 'w', displayName: 'w', now: 1000 }).id
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const sessions = new CodingSessionService(harness.workspaces, harness.sessions)
      const session = await sessions.createSession({ workspaceId })
      await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi' })
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId: session.id }), ProviderCredentialMissingError)
      assert.equal(harness.adapter.generateCalls, 0)
    } finally {
      harness.db.close()
    }
  })

  it('requires a selected model', async () => {
    const harness = openCompletion()
    try {
      const workspaceId = harness.workspaces.create({ rootPath: 'w', displayName: 'w', now: 1000 }).id
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-x' })
      const sessions = new CodingSessionService(harness.workspaces, harness.sessions)
      const session = await sessions.createSession({ workspaceId })
      await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'hi' })
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId: session.id }), ProviderModelMissingError)
      assert.equal(harness.adapter.generateCalls, 0)
    } finally {
      harness.db.close()
    }
  })

  it('refuses generation when the latest message is already assistant', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      await harness.completion.generateResponse({ workspaceId, sessionId })
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), NothingToAnswerError)
      assert.equal(harness.adapter.generateCalls, 1)
    } finally {
      harness.db.close()
    }
  })

  it('allows only one in-flight generation per session', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const adapter = harness.adapter
      const original = adapter.generateText.bind(adapter)
      adapter.generateText = async (request) => {
        await gate
        return original(request)
      }
      const first = harness.completion.generateResponse({ workspaceId, sessionId })
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), GenerationInFlightError)
      release()
      await first
      assert.equal(adapter.generateCalls, 1)
    } finally {
      harness.db.close()
    }
  })

  it('caps context at the latest 40 messages', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1', 'seed')
      const sessions = new CodingSessionService(harness.workspaces, harness.sessions)
      for (let index = 0; index < 60; index += 1) {
        await sessions.sendUserMessage({ workspaceId, sessionId, content: `filler ${String(index)}` })
      }
      const context = harness.completion.loadContext(sessionId)
      assert.ok(context.length <= MAX_AI_CONTEXT_MESSAGES)
      assert.equal(context[context.length - 1]?.content, 'filler 59')
    } finally {
      harness.db.close()
    }
  })

  it('caps context bytes and drops oldest first', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1', 'x'.repeat(60 * 1024))
      const sessions = new CodingSessionService(harness.workspaces, harness.sessions)
      await sessions.sendUserMessage({ workspaceId, sessionId, content: 'y'.repeat(60 * 1024) })
      const context = harness.completion.loadContext(sessionId)
      const bytes = Buffer.byteLength(context.map((entry) => entry.content).join(''), 'utf8')
      assert.ok(bytes <= MAX_AI_CONTEXT_BYTES)
      assert.equal(context[context.length - 1]?.content, 'y'.repeat(60 * 1024))
    } finally {
      harness.db.close()
    }
  })

  it('returns context chronologically', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1', 'first-q')
      await harness.completion.generateResponse({ workspaceId, sessionId })
      const context = harness.completion.loadContext(sessionId)
      assert.deepEqual(
        context.map((entry) => entry.role),
        ['user', 'assistant']
      )
      assert.equal(context[0]?.content, 'first-q')
    } finally {
      harness.db.close()
    }
  })

  it('sends no files or project context to the provider', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      await harness.completion.generateResponse({ workspaceId, sessionId })
      const seen = harness.adapter.seen[0]
      assert.ok(seen !== undefined)
      // Structural allowlist: exactly the five provider-neutral fields.
      assert.deepEqual(Object.keys(seen).sort(), ['apiKey', 'instructions', 'maxOutputTokens', 'messages', 'model'])
      assert.equal(seen?.instructions, (await import('./limits')).STAGE_14_FIXED_INSTRUCTIONS)
      assert.ok(!JSON.stringify(seen?.messages ?? []).includes('rootPath'))
    } finally {
      harness.db.close()
    }
  })

  it('leaves the user message intact when the provider fails', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      harness.adapter.generateError = new ProviderGenericError()
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), ProviderGenericError)
      const messages = harness.sessions.listMessagesNewestFirst(sessionId, 10, null)
      assert.equal(messages.length, 1)
      assert.equal(messages[0]?.role, 'user')
    } finally {
      harness.db.close()
    }
  })

  it('explicit retry creates only the assistant message', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      harness.adapter.generateError = new ProviderGenericError()
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), ProviderGenericError)
      harness.adapter.generateError = null
      harness.adapter.nextText = 'retry reply'
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.message.role, 'assistant')
      assert.equal(result.message.content, 'retry reply')
      const messages = harness.sessions.listMessagesNewestFirst(sessionId, 10, null)
      assert.equal(messages.filter((entry) => entry.role === 'user').length, 1)
      assert.equal(messages.filter((entry) => entry.role === 'assistant').length, 1)
      assert.equal(harness.adapter.generateCalls, 2)
    } finally {
      harness.db.close()
    }
  })

  it('advances updatedAt on successful generation', async () => {
    let now = 1000
    const harness = openCompletion(() => now)
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      now = 5000
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.session.updatedAt, 5000)
    } finally {
      harness.db.close()
    }
  })

  it('never retitles the session from an assistant message', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1', 'Original title words')
      const result = await harness.completion.generateResponse({ workspaceId, sessionId })
      assert.equal(result.session.title, 'Original title words')
    } finally {
      harness.db.close()
    }
  })

  it('rejects oversized assistant output without persisting', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      harness.adapter.nextText = 'z'.repeat(64 * 1024 + 1)
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), ProviderEmptyResponseError)
      assert.equal(harness.sessions.listMessagesNewestFirst(sessionId, 10, null).length, 1)
    } finally {
      harness.db.close()
    }
  })

  it('rejects malformed assistant output without persisting', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      harness.adapter.nextText = '   '
      await assert.rejects(harness.completion.generateResponse({ workspaceId, sessionId }), ProviderEmptyResponseError)
      assert.equal(harness.sessions.listMessagesNewestFirst(sessionId, 10, null).length, 1)
    } finally {
      harness.db.close()
    }
  })

  it('passes no tools object to the adapter', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      await harness.completion.generateResponse({ workspaceId, sessionId })
      for (const call of harness.adapter.seen) {
        assert.ok(!('tools' in call))
      }
    } finally {
      harness.db.close()
    }
  })

  it('stores no provider internals in session tables', async () => {
    const harness = openCompletion()
    try {
      const { workspaceId, sessionId } = await openConfiguredSession(harness, 'w1')
      await harness.completion.generateResponse({ workspaceId, sessionId })
      const rows: unknown = harness.db.prepare('SELECT content FROM coding_messages').all()
      const serialized = JSON.stringify(rows)
      assert.ok(!serialized.includes('sk-test'))
      assert.ok(!serialized.includes('Authorization'))
      assert.ok(!serialized.includes('output_text'))
    } finally {
      harness.db.close()
    }
  })
})
