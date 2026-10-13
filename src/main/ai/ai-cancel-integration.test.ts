import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiBrainService } from './ai-brain-service'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiCompletionService } from './ai-completion-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { AiCancelledError, ProviderTimeoutError } from './errors'
import type {
  AiProviderAdapter,
  HostedSessionProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { failureCategoryOf } from '../usage/ai-usage-tracker'

/**
 * User-cancellation integration proof (no network, no keys).
 * Fakes honor AbortSignal exactly like production adapters: an
 * aborted in-flight call rejects with AiCancelledError, which never
 * fails over, applies nothing, and releases the guard so the
 * session is immediately reusable. Timeout stays timeout.
 */

const A = 'builtin:gpt-5.6-luna'
const B = 'builtin:claude-haiku-5.5'

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

function abortable<T>(signal: AbortSignal | undefined, ms: number, value: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AiCancelledError())
      return
    }
    const timer = setTimeout(() => resolve(value()), ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new AiCancelledError())
      },
      { once: true }
    )
  })
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

class AbortableStarkAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  readonly calls: string[] = []
  hangModels = new Set<string>()
  failModels = new Map<string, unknown>()
  constructor(private readonly hangMs = 40) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: A }, { id: B }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push(request.model)
    const failure = this.failModels.get(request.model)
    if (failure !== undefined) {
      throw failure
    }
    if (this.hangModels.has(request.model)) {
      return abortable(request.signal, this.hangMs, () => ({ text: `reply from ${request.model}` }))
    }
    return { text: `reply from ${request.model}` }
  }
  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push(`structured:${request.model}`)
    const failure = this.failModels.get(request.model)
    if (failure !== undefined) {
      throw failure
    }
    if (this.hangModels.has(request.model)) {
      return abortable(request.signal, this.hangMs, () => ({
        outputText: JSON.stringify({
          action: 'delegate',
          planSummary: 'Delegate it.',
          finalAnswer: null,
          workerInstruction: 'Do it.',
          workerProfile: 'general'
        })
      }))
    }
    return {
      outputText: JSON.stringify({
        action: 'delegate',
        planSummary: 'Delegate it.',
        finalAnswer: null,
        workerInstruction: 'Do it.',
        workerProfile: 'general'
      })
    }
  }
}

class AbortableOpenAiAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  readonly calls: string[] = []
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }
  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push(request.model)
    return abortable(request.signal, 40, () => ({ outputText: JSON.stringify({ summary: 'x', proposedContent: 'changed\n' }) }))
  }
}

const SIGNED_IN: HostedSessionProvider = { getAccessToken: async () => 'ACCESS-MARKER' }

function openAsk(): {
  db: DatabaseSync
  completion: AiCompletionService
  runs: OrchestrationRepository
  sessions: CodingSessionRepository
  guard: AiOperationGuard
  adapter: AbortableStarkAdapter
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const sessions = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const adapter = new AbortableStarkAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, { hostedSessionProvider: SIGNED_IN })
  const guard = new AiOperationGuard()
  const runs = new OrchestrationRepository(db)
  const completion = new AiCompletionService(workspaces, sessions, providerRows, providerService, registry, { now: () => 9000, operationGuard: guard, runs })
  const workspaceId = workspaces.create({ rootPath: 'w-cancel-ask', displayName: 'w', now: 1000 }).id
  return { db, completion, runs, sessions, guard, adapter, workspaceId }
}

async function openAskSession(sessions: CodingSessionRepository, workspaceId: number): Promise<number> {
  const sessionId = sessions.createSession({ workspaceId, title: 's', now: 1000 })
  sessions.appendMessage({ sessionId, role: 'user', content: 'hi', now: 2000, retitle: null })
  return sessionId
}

describe('ask cancellation', () => {
  it('cancel aborts the in-flight provider call without failing over', async () => {
    const h = openAsk()
    try {
      h.adapter.hangModels.add(A)
      const sessionId = await openAskSession(h.sessions, h.workspaceId)
      const pending = h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId, brainModels: [A, B] })
      await waitFor(() => h.adapter.calls.length > 0, 'provider call to start')
      assert.equal(h.guard.requestCancel(sessionId), true)
      await assert.rejects(pending, AiCancelledError)
      assert.deepEqual(h.adapter.calls, [A], 'B must never be attempted after cancel')
      assert.equal(h.guard.isActive(sessionId), false, 'guard must release after cancel')
      const recent = h.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'failed')
      const steps = h.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.status, 'failed')
      const messages = h.sessions.listMessagesNewestFirst(sessionId, 10, null)
      assert.ok(messages.every((entry) => entry.role !== 'assistant'), 'cancel applies nothing')
    } finally {
      h.db.close()
    }
  })

  it('the session is reusable immediately after cancellation', async () => {
    const h = openAsk()
    try {
      h.adapter.hangModels.add(A)
      const sessionId = await openAskSession(h.sessions, h.workspaceId)
      const pending = h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId, brainModels: [A] })
      await waitFor(() => h.adapter.calls.length > 0, 'provider call to start')
      h.guard.requestCancel(sessionId)
      await assert.rejects(pending, AiCancelledError)
      h.adapter.hangModels.clear()
      const result = await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId, brainModels: [A] })
      assert.ok(result.message.content.includes(A))
    } finally {
      h.db.close()
    }
  })

  it('timeout stays timeout and is never reported as cancelled', async () => {
    const h = openAsk()
    try {
      h.adapter.failModels.set(A, new ProviderTimeoutError())
      const sessionId = await openAskSession(h.sessions, h.workspaceId)
      const error = await h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId, brainModels: [A] }).then(
        () => null,
        (caught: unknown) => caught
      )
      assert.ok(error instanceof ProviderTimeoutError)
      assert.ok(!(error instanceof AiCancelledError))
      assert.equal((error as Error).message, 'The AI provider request timed out. Try again.')
      assert.equal(h.guard.isActive(sessionId), false)
      assert.equal(failureCategoryOf(error), 'provider-timeout')
      assert.equal(failureCategoryOf(new AiCancelledError()), 'cancelled')
    } finally {
      h.db.close()
    }
  })
})

describe('work cancellation during brain planning', () => {
  it('cancel fails the run without corrupting state', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const workspaces = new WorkspaceRepository(db)
      const rows = new CodingSessionRepository(db)
      const providerRows = new AiProviderRepository(db)
      const runs = new OrchestrationRepository(db)
      const dir = mkdtempSync(join(tmpdir(), 'stark-cancel-work-'))
      try {
        const root = join(dir, 'project')
        mkdirSync(root, { recursive: true })
        const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1000 }).id
        const adapter = new AbortableStarkAdapter()
        adapter.hangModels.add(A)
        const registry = new ProviderRegistry()
        registry.register(adapter)
        const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, { hostedSessionProvider: SIGNED_IN })
        const guard = new AiOperationGuard()
        const brain = new AiBrainService(workspaces, rows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
          operationGuard: guard
        })
        const sessions = new CodingSessionService(workspaces, rows)
        const session = await sessions.createSession({ workspaceId })
        await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'tiny edit' })
        const pending = brain.runBrain({ workspaceId, sessionId: session.id, brainModels: [A, B] })
        await waitFor(() => adapter.calls.length > 0, 'brain plan to start')
        assert.equal(guard.requestCancel(session.id), true)
        await assert.rejects(pending, AiCancelledError)
        assert.deepEqual(
          adapter.calls.filter((call) => !call.startsWith('structured:')),
          [],
          'no worker text call may start after a cancelled plan'
        )
        assert.equal(guard.isActive(session.id), false)
        const recent = runs.listRecentForSession(session.id, 5)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]?.status, 'failed')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      db.close()
    }
  })
})

describe('propose cancellation', () => {
  it('cancel aborts the proposal with no transaction and a failed run', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const workspaces = new WorkspaceRepository(db)
      const codingRows = new CodingSessionRepository(db)
      const providerRows = new AiProviderRepository(db)
      const changeRows = new ChangeTransactionRepository(db)
      const files = new WorkspaceFilesService(workspaces)
      const writer = new WorkspaceFileWriteService(workspaces)
      const dir = mkdtempSync(join(tmpdir(), 'stark-cancel-propose-'))
      try {
        const root = join(dir, 'project')
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'app.ts'), 'const alpha = 1\n')
        const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1000 }).id
        const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
        const adapter = new AbortableOpenAiAdapter()
        const registry = new ProviderRegistry()
        registry.register(adapter)
        const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
        await providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
        await providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
        const guard = new AiOperationGuard()
        const runs = new OrchestrationRepository(db)
        const proposals = new AiCodeProposalService(workspaces, codingRows, providerRows, providerService, registry, files, transactions, {
          operationGuard: guard,
          runs
        })
        const context = new SessionContextService(workspaces, files)
        const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
        const session = await sessions.createSession({ workspaceId })
        const whole = await context.prepareWholeFile({ workspaceId, relativePath: 'app.ts' })
        await sessions.sendUserMessage({ workspaceId, sessionId: session.id, content: 'Change this.', context: [whole] })
        const pending = proposals.proposeFileChange({ workspaceId, sessionId: session.id })
        await waitFor(() => adapter.calls.length > 0, 'proposal call to start')
        assert.equal(guard.requestCancel(session.id), true)
        await assert.rejects(pending, AiCancelledError)
        assert.equal(guard.isActive(session.id), false)
        const recent = runs.listRecentForSession(session.id, 5)
        assert.equal(recent.length, 1)
        assert.equal(recent[0]?.status, 'failed')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      db.close()
    }
  })
})
