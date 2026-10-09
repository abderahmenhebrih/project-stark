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
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeSetService } from '../change-sets/change-set-service'
import { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import { AiBrainService } from '../ai/ai-brain-service'
import { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { OpenAiProviderAdapter, type OpenAiClientLike } from '../ai/openai-adapter'
import { AiUsageRepository } from './ai-usage-repository'
import { AiUsageService } from './ai-usage-service'
import { AiUsageTracker } from './ai-usage-tracker'

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

class TaggingAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: { readonly kind: 'structured' | 'text'; readonly model: string }[] = []
  nextPlan = ''
  nextTexts: string[] = []

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push({ kind: 'text', model: request.model })
    const next = this.nextTexts.shift()
    if (next === undefined) {
      throw new Error('no scripted text left')
    }
    return { text: next }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push({ kind: 'structured', model: request.model })
    return { outputText: this.nextPlan }
  }
}

const NOW = 5_000_000_000

function openBase(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  workspaces: WorkspaceRepository
  codingRows: CodingSessionRepository
  providerRows: AiProviderRepository
  providerService: AiProviderService
  registry: ProviderRegistry
  adapter: TaggingAdapter
  usageRepo: AiUsageRepository
  usageService: AiUsageService
  usageTracker: AiUsageTracker
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-usage-obs-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'title.ts'), 'export const title = "OLD"\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const adapter = new TaggingAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const usageRepo = new AiUsageRepository(db)
  const usageService = new AiUsageService(usageRepo, registry, { now: () => NOW })
  const usageTracker = new AiUsageTracker(usageRepo, () => NOW)
  return { db, dir, workspaceId, workspaces, codingRows, providerRows, providerService, registry, adapter, usageRepo, usageService, usageTracker }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

function usageOps(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT operation FROM ai_usage_events ORDER BY id ASC').all() as { operation: string }[]
  return rows.map((row) => row.operation)
}

describe('ask and proposal usage tracking without routing', () => {
  it('ask is tracked on the legacy model and never threshold-routed', async () => {
    const h = openBase()
    try {
      await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
      // Threshold reached on the legacy model with an alternate ready.
      for (let index = 0; index < 90; index += 1) {
        const { id } = h.usageRepo.reserveEvent({
          providerId: 'openai', model: 'model-LEGACY', operation: 'ask', role: 'ask',
          workspaceId: h.workspaceId, sessionId: null, runId: null, now: NOW - 1000 - index
        })
        h.usageRepo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: NOW - 999 - index })
      }
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-LEGACY', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      const sessions = new CodingSessionService(h.workspaces, h.codingRows)
      const completion = new AiCompletionService(h.workspaces, h.codingRows, h.providerRows, h.providerService, h.registry, {
        operationGuard: new AiOperationGuard(),
        usage: { tracker: h.usageTracker, service: h.usageService }
      })
      const session = await sessions.createSession({ workspaceId: h.workspaceId })
      await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Hello.' })
      h.adapter.nextTexts = ['ASK_REPLY']
      const result = await completion.generateResponse({ workspaceId: h.workspaceId, sessionId: session.id })
      assert.equal(result.message.content, 'ASK_REPLY')
      assert.deepEqual(h.adapter.calls.map((call) => call.model), ['model-LEGACY'])
      assert.deepEqual(usageOps(h.db).slice(-1), ['ask'])
    } finally {
      closeHarness(h)
    }
  })

  it('single-file proposals are tracked and never threshold-routed', async () => {
    const h = openBase()
    try {
      await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await h.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      for (let index = 0; index < 90; index += 1) {
        const { id } = h.usageRepo.reserveEvent({
          providerId: 'openai', model: 'gpt-4o', operation: 'ask', role: 'ask',
          workspaceId: h.workspaceId, sessionId: null, runId: null, now: NOW - 1000 - index
        })
        h.usageRepo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: NOW - 999 - index })
      }
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'gpt-4o', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      const files = new WorkspaceFilesService(h.workspaces)
      const writer = new WorkspaceFileWriteService(h.workspaces)
      const changeRows = new ChangeTransactionRepository(h.db)
      const transactions = new ChangeTransactionService(h.workspaces, changeRows, writer)
      const proposals = new AiCodeProposalService(
        h.workspaces, h.codingRows, h.providerRows, h.providerService, h.registry, files, transactions,
        { operationGuard: new AiOperationGuard(), usage: { tracker: h.usageTracker, service: h.usageService } }
      )
      const context = new SessionContextService(h.workspaces, files)
      const sessions = new CodingSessionService(h.workspaces, h.codingRows, { contextService: context })
      const session = await sessions.createSession({ workspaceId: h.workspaceId })
      const whole = await context.prepareWholeFile({ workspaceId: h.workspaceId, relativePath: 'title.ts' })
      await sessions.sendUserMessage({
        workspaceId: h.workspaceId, sessionId: session.id, content: 'Change it.', context: [whole]
      })
      h.adapter.nextPlan = JSON.stringify({ summary: 'Change the title', proposedContent: 'export const title = "NEW"\n' })
      const result = await proposals.proposeFileChange({ workspaceId: h.workspaceId, sessionId: session.id })
      assert.equal(result.transaction.status, 'pending')
      assert.deepEqual(h.adapter.calls.map((call) => call.model), ['gpt-4o'])
      assert.deepEqual(usageOps(h.db).slice(-1), ['single_proposal'])
    } finally {
      closeHarness(h)
    }
  })

  it('multi-file proposals are tracked and never threshold-routed', async () => {
    const h = openBase()
    try {
      await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await h.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const { id: seeded } = h.usageRepo.reserveEvent({
        providerId: 'openai', model: 'gpt-4o', operation: 'ask', role: 'ask',
        workspaceId: h.workspaceId, sessionId: null, runId: null, now: NOW - 1000
      })
      h.usageRepo.finalizeSuccess(seeded, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: NOW - 999 })
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'gpt-4o', maxCalls24h: 1, maxTotalTokens24h: null, switchAtPercent: 1 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      writeFileSync(join(h.dir, 'project', 'other.ts'), 'export const other = 2\n')
      const files = new WorkspaceFilesService(h.workspaces)
      const changeRows = new ChangeTransactionRepository(h.db)
      const changeSets = new ChangeSetService(h.workspaces, new ChangeSetRepository(h.db), changeRows)
      const proposals = new AiMultiFileProposalService(
        h.workspaces, h.codingRows, h.providerRows, h.providerService, h.registry, files, changeSets,
        { operationGuard: new AiOperationGuard(), usage: { tracker: h.usageTracker, service: h.usageService } }
      )
      const context = new SessionContextService(h.workspaces, files)
      const sessions = new CodingSessionService(h.workspaces, h.codingRows, { contextService: context })
      const session = await sessions.createSession({ workspaceId: h.workspaceId })
      const drafts = []
      for (const name of ['title.ts', 'other.ts']) {
        drafts.push(await context.prepareWholeFile({ workspaceId: h.workspaceId, relativePath: name }))
      }
      await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Bump both.', context: drafts })
      // Threshold already reached on gpt-4o, yet the proposal still uses it.
      h.adapter.nextPlan = JSON.stringify({
        summary: 'bump both',
        changes: [
          { targetId: 'T1', summary: 'bump title', proposedContent: 'export const title = "MULTI"\n' },
          { targetId: 'T2', summary: 'bump other', proposedContent: 'export const other = 3\n' }
        ]
      })
      const result = await proposals.proposeChangeSet({ workspaceId: h.workspaceId, sessionId: session.id })
      assert.equal(result.changeSet.items.length, 2)
      assert.deepEqual(h.adapter.calls.map((call) => call.model), ['gpt-4o'])
      assert.deepEqual(usageOps(h.db).slice(-1), ['multi_proposal'])
    } finally {
      closeHarness(h)
    }
  })
})

describe('recovery usage tracking without threshold routing', () => {
  it('recovery routes stay explicit and are tracked with recovery operations', async () => {
    const h = openBase()
    try {
      await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
      const heart = new HeartService(new HeartRepository(h.db), h.providerRows, h.registry)
      heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'model-A' },
        workerFixed: { providerId: 'openai', model: 'model-B' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      // Threshold reached on the RECOVERY brain model with an alternate ready.
      for (let index = 0; index < 90; index += 1) {
        const { id } = h.usageRepo.reserveEvent({
          providerId: 'openai', model: 'model-R', operation: 'ask', role: 'ask',
          workspaceId: h.workspaceId, sessionId: null, runId: null, now: NOW - 1000 - index
        })
        h.usageRepo.finalizeSuccess(id, { inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 1, now: NOW - 999 - index })
      }
      h.usageService.updateConfig({
        heartThresholdRoutingEnabled: true,
        limits: [{ providerId: 'openai', model: 'model-R', maxCalls24h: 100, maxTotalTokens24h: null, switchAtPercent: 90 }],
        alternates: [{ routeKey: 'brain.primary', providerId: 'openai', model: 'model-X' }]
      })
      const runs = new OrchestrationRepository(h.db)
      const brain = new AiBrainService(h.workspaces, h.codingRows, h.providerService, runs, heart, {
        operationGuard: new AiOperationGuard(),
        usage: { tracker: h.usageTracker, service: h.usageService }
      })
      const sessions = new CodingSessionService(h.workspaces, h.codingRows)
      const session = await sessions.createSession({ workspaceId: h.workspaceId })
      await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Hi.' })
      h.adapter.nextPlan = JSON.stringify({
        action: 'answer', planSummary: 'Recovered.', finalAnswer: 'RECOVERED', workerInstruction: null, workerProfile: null
      })
      const outcome = await brain.runBrainRecoveryTextOnly(
        { workspaceId: h.workspaceId, sessionId: session.id },
        { brain: { providerId: 'openai', model: 'model-R' }, worker: { providerId: 'openai', model: 'model-RW' } }
      )
      assert.equal(outcome.finalText, 'RECOVERED')
      // Recovery used its explicit assignment — not the threshold alternate.
      assert.deepEqual(h.adapter.calls.map((call) => call.model), ['model-R'])
      assert.deepEqual(usageOps(h.db).slice(-1), ['recovery_brain_plan'])
      assert.equal(h.usageService.decisionsForRun(outcome.runId).length, 0)
    } finally {
      closeHarness(h)
    }
  })
})

describe('openai adapter usage mapping', () => {
  function fakeClient(response: unknown): OpenAiClientLike {
    return {
      models: {
        list: async () => ({ data: [] })
      },
      responses: {
        create: async () => response as { output_text?: string; output?: readonly unknown[] }
      }
    }
  }

  it('maps reported Responses-API usage into provider usage', async () => {
    const adapter = new OpenAiProviderAdapter(() =>
      fakeClient({ output_text: 'hi', usage: { input_tokens: 7, output_tokens: 8, total_tokens: 15 } })
    )
    const text = await adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 10 })
    assert.deepEqual(text.usage, { inputTokens: 7, outputTokens: 8, totalTokens: 15 })
    const structured = await adapter.generateStructured({
      apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 10, schemaName: 's', schema: {}
    })
    assert.deepEqual(structured.usage, { inputTokens: 7, outputTokens: 8, totalTokens: 15 })
  })

  it('reports null usage when the provider reports nothing (never estimates)', async () => {
    const adapter = new OpenAiProviderAdapter(() => fakeClient({ output_text: 'hi' }))
    const text = await adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 10 })
    assert.equal(text.usage, null)
    const bad = new OpenAiProviderAdapter(() =>
      fakeClient({ output_text: 'hi', usage: { input_tokens: 'lots', output_tokens: -3, total_tokens: null } })
    )
    const result = await bad.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 10 })
    assert.equal(result.usage, null)
  })

  it('stores no response ids, bodies, or request state', async () => {
    const adapter = new OpenAiProviderAdapter(() =>
      fakeClient({ output_text: 'hi', id: 'resp-123', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
    )
    const result = await adapter.generateText({ apiKey: 'k', model: 'm', instructions: 'i', messages: [], maxOutputTokens: 10 })
    assert.deepEqual(Object.keys(result).sort(), ['text', 'usage'])
  })
})
