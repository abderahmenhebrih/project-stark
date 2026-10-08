import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { LooplinkRepository } from './looplink-repository'
import { LooplinkService, deriveContinuationTitle } from './looplink-service'
import {
  LooplinkNoUserWorkError,
  LooplinkNotPendingError,
  LooplinkSourceBusyError
} from './looplink-errors'
import { MAX_LOOPLINK_PAYLOAD_BYTES } from './looplink-limits'
import { byteLengthOf, serializeLooplinkPayload } from './looplink-payload'
import { SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'

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

  async generateText(): Promise<{ text: string }> {
    return { text: 'unused' }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  context: SessionContextService
  runs: OrchestrationRepository
  looplinks: LooplinkRepository
  service: LooplinkService
  guard: AiOperationGuard
  providerService: AiProviderService
  workspaces: WorkspaceRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const runs = new OrchestrationRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-looplink-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const alpha = 1\nconst beta = 2\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const registry = new ProviderRegistry()
  registry.register(new FakeAdapter())
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const looplinks = new LooplinkRepository(db)
  const guard = new AiOperationGuard()
  const service = new LooplinkService(workspaces, codingRows, looplinks, guard, runs, setRows, changeRows)
  return { db, dir, root, workspaceId, sessions, codingRows, context, runs, looplinks, service, guard, providerService, workspaces }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

describe('looplink service', () => {
  it('creates target plus pending handoff with title and latest message', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'First question.' })
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.ok(result.targetSession.id !== source.id)
      assert.equal(result.targetSession.workspaceId, harness.workspaceId)
      // The first user message retitled the source, so the title tracks it.
      assert.equal(result.targetSession.title, 'Continue: First question.')
      assert.equal(result.looplink.status, 'pending')
      assert.ok(result.looplink.payload.messages.some((entry) => entry.content === 'First question.'))
      // No message rows cloned into the target.
      assert.equal(harness.codingRows.listMessagesNewestFirst(result.targetSession.id, 10, null).length, 0)
      assert.equal(deriveContinuationTitle('New session'), 'Continue: New session')
    } finally {
      closeHarness(harness)
    }
  })

  it('rejects sessions without user work and creates nothing', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await assert.rejects(
        harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id }),
        LooplinkNoUserWorkError
      )
      assert.equal(harness.codingRows.listRecentSessions(harness.workspaceId, 50).length, 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('caps messages at 12 newest with accurate omission counts', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      for (let index = 1; index <= 16; index += 1) {
        await harness.sessions.sendUserMessage({
          workspaceId: harness.workspaceId,
          sessionId: source.id,
          content: `message ${String(index)}`
        })
      }
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.equal(result.looplink.payload.messages.length, 12)
      assert.equal(result.looplink.payload.messages[0]?.content, 'message 5')
      assert.equal(result.looplink.payload.messages[11]?.content, 'message 16')
      assert.equal(result.looplink.payload.omissions.messageCount, 4)
    } finally {
      closeHarness(harness)
    }
  })

  it('keeps whole message text intact and fits the byte budget', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const bodies: string[] = []
      for (let index = 1; index <= 6; index += 1) {
        const body = `body-${String(index)}-` + 'x'.repeat(20_000)
        bodies.push(body)
        await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: body })
      }
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      for (const entry of result.looplink.payload.messages) {
        assert.ok(bodies.includes(entry.content), 'message text must never be cut')
      }
      const serialized = serializeLooplinkPayload(result.looplink.payload)
      assert.ok(byteLengthOf(serialized) <= MAX_LOOPLINK_PAYLOAD_BYTES)
    } finally {
      closeHarness(harness)
    }
  })

  it('captures only persisted sent context, never unattached files', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: 'Watch this.' })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        content: 'Review.',
        context: [whole, note]
      })
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.equal(result.looplink.payload.explicitContext.length, 2)
      assert.equal(result.looplink.payload.explicitContext[0]?.relativePath, 'app.ts')
      assert.equal(result.looplink.payload.omissions.contextCount, 0)
    } finally {
      closeHarness(harness)
    }
  })

  it('includes latest orchestration metadata with bounded worker result', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const sent = await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const runId = harness.runs.createRun({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        userMessageId: sent.message.id,
        now: 2000
      })
      harness.runs.appendStep({
        runId, ordinal: 0, kind: 'brain_plan', status: 'completed', instruction: null, output: 'Plan it.', now: 2000
      })
      harness.runs.appendStep({
        runId, ordinal: 1, kind: 'worker', status: 'completed', instruction: 'Do it.', output: 'small result', now: 2000
      })
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.equal(result.looplink.payload.orchestration?.planSummary, null)
      // Header plan_summary is null for direct repo inserts; status carries through.
      assert.equal(result.looplink.payload.orchestration?.status, 'running')
      assert.equal(result.looplink.payload.orchestration?.workerResult, 'small result')
      assert.equal(result.looplink.payload.orchestration?.workerResultOmitted, false)
    } finally {
      closeHarness(harness)
    }
  })

  it('omits oversized worker results whole with the flag set', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const sent = await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const runId = harness.runs.createRun({
        workspaceId: harness.workspaceId,
        sessionId: source.id,
        userMessageId: sent.message.id,
        now: 2000
      })
      harness.runs.appendStep({
        runId, ordinal: 0, kind: 'worker', status: 'completed', instruction: 'Do it.', output: `y`.repeat(40_000), now: 2000
      })
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      assert.equal(result.looplink.payload.orchestration?.workerResult, null)
      assert.equal(result.looplink.payload.orchestration?.workerResultOmitted, true)
    } finally {
      closeHarness(harness)
    }
  })

  it('exposes no credentials in the snapshot', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-live-secret-key' })
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const result = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      const serialized = serializeLooplinkPayload(result.looplink.payload)
      assert.ok(!serialized.includes('sk-live-secret-key'))
      assert.ok(!serialized.includes('encrypted_api_key'))
      assert.ok(!serialized.includes('OPENAI_API_KEY'))
    } finally {
      closeHarness(harness)
    }
  })

  it('builds chained continuations from target messages without nesting payloads', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Original work.' })
      const first = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: first.targetSession.id,
        content: 'Follow-up in target.'
      })
      const second = await harness.service.createContinuation({
        workspaceId: harness.workspaceId,
        sourceSessionId: first.targetSession.id
      })
      const serialized = serializeLooplinkPayload(second.looplink.payload)
      // Built from the target session's own persisted messages only:
      // one message, no nested raw payload arrays.
      assert.deepEqual(
        second.looplink.payload.messages.map((entry) => entry.content),
        ['Follow-up in target.']
      )
      assert.equal((serialized.match(/"messages":\[/g) ?? []).length, 1)
      assert.equal((serialized.match(/"explicitContext"/g) ?? []).length, 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('reads back pending continuity and dismisses it', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      const created = await harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id })
      const preview = await harness.service.getForSession({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.equal(preview?.status, 'pending')
      assert.equal(preview?.id, created.looplink.id)
      const dismissed = await harness.service.dismissForSession({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id })
      assert.equal(dismissed.status, 'dismissed')
      assert.equal(await harness.service.getForSession({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }), null)
      await assert.rejects(
        harness.service.dismissForSession({ workspaceId: harness.workspaceId, sessionId: created.targetSession.id }),
        LooplinkNotPendingError
      )
    } finally {
      closeHarness(harness)
    }
  })

  it('rejects busy sources and cross-workspace scope', async () => {
    const harness = openHarness()
    try {
      const source = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: source.id, content: 'Hi.' })
      harness.guard.acquire(source.id)
      try {
        await assert.rejects(
          harness.service.createContinuation({ workspaceId: harness.workspaceId, sourceSessionId: source.id }),
          LooplinkSourceBusyError
        )
      } finally {
        harness.guard.release(source.id)
      }
      await assert.rejects(
        harness.service.getForSession({ workspaceId: harness.workspaceId, sessionId: 999999 }),
        Error
      )
      const otherWorkspaceId = harness.workspaces.create({ rootPath: `${harness.root}-other`, displayName: 'other', now: 5000 }).id
      await assert.rejects(
        harness.service.createContinuation({ workspaceId: 999999, sourceSessionId: source.id }),
        SessionWorkspaceUnavailableError
      )
      await assert.rejects(
        harness.service.createContinuation({ workspaceId: otherWorkspaceId, sourceSessionId: source.id }),
        SessionWorkspaceMismatchError
      )
    } finally {
      closeHarness(harness)
    }
  })
})
