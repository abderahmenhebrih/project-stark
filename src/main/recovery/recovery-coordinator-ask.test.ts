import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import { AiBrainService } from '../ai/ai-brain-service'
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
import {
  ProviderForbiddenError,
  ProviderInvalidCredentialError,
  ProviderNetworkError,
  ProviderRateLimitedError
} from '../ai/errors'
import { RecoveryRepository } from './recovery-repository'
import { RecoveryService } from './recovery-service'
import { AiRecoveryCoordinator } from './recovery-coordinator'

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

interface TextCall {
  readonly kind: 'text'
  readonly model: string
  readonly messages: readonly { readonly content: string }[]
}
interface StructuredCall {
  readonly kind: 'structured'
  readonly model: string
}

class ScriptedAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: (TextCall | StructuredCall)[] = []
  textImpl: (model: string, messages: readonly { readonly content: string }[]) => Promise<string> = async () => 'OK'
  structuredImpl: (model: string) => Promise<string> = async () => '{}'

  constructor(readonly id: ProviderId) {}

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.calls.push({ kind: 'text', model: request.model, messages: request.messages })
    const text = await this.textImpl(request.model, request.messages)
    return { text }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push({ kind: 'structured', model: request.model })
    const outputText = await this.structuredImpl(request.model)
    return { outputText }
  }
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  completion: AiCompletionService
  brain: AiBrainService
  providerService: AiProviderService
  looplinks: LooplinkRepository
  loopService: LooplinkService
  recoveryStore: RecoveryRepository
  recoveryService: RecoveryService
  coordinator: AiRecoveryCoordinator
  adapter: ScriptedAdapter
  guard: AiOperationGuard
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const looplinks = new LooplinkRepository(db)
  const recoveryStore = new RecoveryRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-rec-ask-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new ScriptedAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const guard = new AiOperationGuard()
  const loopService = new LooplinkService(workspaces, codingRows, looplinks, guard, runs)
  const completion = new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
    operationGuard: guard,
    looplink: { service: loopService, store: looplinks }
  })
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: guard,
    looplink: { service: loopService, store: looplinks }
  })
  const recoveryService = new RecoveryService(recoveryStore, providerRows, registry)
  const coordinator = new AiRecoveryCoordinator({
    workspaces,
    sessions: codingRows,
    orchestrationRuns: runs,
    completion,
    brain,
    looplinkService: loopService,
    looplinkStore: looplinks,
    recoveryStore,
    recoveryService
  })
  return { db, dir, workspaceId, sessions, codingRows, completion, brain, providerService, looplinks, loopService, recoveryStore, recoveryService, coordinator, adapter, guard }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function seedAsk(harness: ReturnType<typeof openHarness>, legacyModel = 'model-P'): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: legacyModel })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hello recovery.' })
  return session.id
}

function setAutoOnce(harness: ReturnType<typeof openHarness>): void {
  harness.recoveryService.updateConfig({
    mode: 'auto_once',
    ask: { providerId: 'openai', model: 'model-R' },
    brain: { providerId: 'openai', model: 'model-RB' },
    worker: { providerId: 'openai', model: 'model-RW' }
  })
}

describe('ask recovery (single-hop)', () => {
  it('off surfaces rate-limit with no target/event (1 call)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      h.recoveryService.updateConfig({ mode: 'off', ask: null, brain: null, worker: null })
      h.adapter.textImpl = async (model) => {
        assert.equal(model, 'model-P')
        throw new ProviderRateLimitedError()
      }
      await assert.rejects(h.coordinator.ask({ workspaceId: h.workspaceId, sessionId }), /rate-limiting/i)
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.looplinks.listRecentFromSource(sessionId, 20).length, 0)
      assert.equal(h.recoveryStore.findEventByTarget(sessionId), undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('handoff creates target+looplink+event with 1 call, no replay, attempt 0', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      h.recoveryService.updateConfig({ mode: 'handoff', ask: null, brain: null, worker: null })
      h.adapter.textImpl = async () => {
        throw new ProviderRateLimitedError()
      }
      const outcome = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'recovery_handoff')
      if (outcome.kind !== 'recovery_handoff') throw new Error('unreachable')
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(outcome.recoveryEvent.status, 'handoff_ready')
      assert.equal(outcome.recoveryEvent.attemptCount, 0)
      assert.equal(outcome.recoveryEvent.operation, 'ask')
      assert.equal(outcome.recoveryEvent.failureCategory, 'provider-rate-limit')
      // No target user message, no assistant.
      const targetMessages = h.codingRows.listMessagesNewestFirst(outcome.targetSession.id, 10, null)
      assert.equal(targetMessages.length, 0)
      assert.equal(h.looplinks.findByTargetSession(outcome.targetSession.id)?.status, 'pending')
      assert.ok(outcome.targetSession.title.startsWith('Recovery:'))
    } finally {
      closeHarness(h)
    }
  })

  it('auto_once rate-limit recovers with exactly P,R (2 calls), Looplink consumed, legacy unchanged', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        if (model === 'model-R') return 'RECOVERY_OK'
        throw new Error(`unexpected model ${model}`)
      }
      const outcome = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'recovered')
      assert.deepEqual(
        h.adapter.calls.map((c) => (c.kind === 'text' ? c.model : 'structured')),
        ['model-P', 'model-R']
      )
      assert.equal(h.adapter.calls.length, 2)
      if (outcome.kind !== 'recovered') throw new Error('unreachable')
      assert.equal(outcome.assistantMessage.content, 'RECOVERY_OK')
      assert.equal(outcome.recoveryEvent.status, 'succeeded')
      assert.equal(outcome.recoveryEvent.attemptCount, 1)
      // One target session, one looplink, one event, one replay + one assistant.
      const targetMessages = h.codingRows.listMessagesNewestFirst(outcome.targetSession.id, 10, null)
      assert.equal(targetMessages.length, 2)
      assert.equal(h.looplinks.findByTargetSession(outcome.targetSession.id)?.status, 'consumed')
      // Source has no fake assistant.
      const sourceMessages = h.codingRows.listMessagesNewestFirst(sessionId, 10, null)
      assert.equal(sourceMessages.length, 1)
      assert.equal(sourceMessages[0]?.role, 'user')
      // Legacy selected model unchanged.
      assert.equal((await h.providerService.getState({ providerId: 'openai' })).selectedModel, 'model-P')
      // Route audit persisted.
      const routes = h.recoveryStore.listRoutes(outcome.recoveryEvent.id)
      assert.deepEqual(routes, [{ role: 'ask', providerId: 'openai', model: 'model-R' }])
    } finally {
      closeHarness(h)
    }
  })

  it('auto_once recovery failure stops with 2 calls, event failed, Looplink pending, no assistant', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        if (model === 'model-R') throw new ProviderNetworkError()
        throw new Error(`unexpected ${model}`)
      }
      const outcome = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'recovery_handoff')
      if (outcome.kind !== 'recovery_handoff') throw new Error('unreachable')
      assert.equal(outcome.recoveryEvent.status, 'failed')
      assert.equal(h.adapter.calls.length, 2)
      const targetMessages = h.codingRows.listMessagesNewestFirst(outcome.targetSession.id, 10, null)
      // Replay user remains, no assistant.
      assert.equal(targetMessages.length, 1)
      assert.equal(targetMessages[0]?.role, 'user')
      assert.equal(h.looplinks.findByTargetSession(outcome.targetSession.id)?.status, 'pending')
    } finally {
      closeHarness(h)
    }
  })

  it('auth failure never triggers recovery even in auto_once', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async () => {
        throw new ProviderInvalidCredentialError()
      }
      await assert.rejects(h.coordinator.ask({ workspaceId: h.workspaceId, sessionId }), /rejected/i)
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.looplinks.listRecentFromSource(sessionId, 20).length, 0)
      assert.equal(h.recoveryStore.findEventBySource(sessionId, 1, 'ask'), undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('permission (403) never triggers recovery', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async () => {
        throw new ProviderForbiddenError()
      }
      await assert.rejects(h.coordinator.ask({ workspaceId: h.workspaceId, sessionId }), /permission/i)
      assert.equal(h.adapter.calls.length, 1)
      assert.equal(h.looplinks.listRecentFromSource(sessionId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('duplicate source failure reuses one event/target (no second handoff)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        return 'RECOVERY_OK'
      }
      const first = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(first.kind, 'recovered')
      const callsAfterFirst = h.adapter.calls.length
      // Second coordinator call retries the same source: primary is
      // attempted once more (same recoverable failure), but no second
      // target/event is created — the existing event is reused.
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        throw new Error('recovery must not be called again')
      }
      const second = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(second.kind, 'recovery_handoff')
      assert.equal(h.adapter.calls.length, callsAfterFirst + 1)
      if (first.kind !== 'recovered' || second.kind !== 'recovery_handoff') throw new Error('unreachable')
      assert.equal(first.targetSession.id, second.targetSession.id)
      assert.equal(first.recoveryEvent.id, second.recoveryEvent.id)
    } finally {
      closeHarness(h)
    }
  })

  it('recovery target failure never creates another target (no recursion)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        if (model === 'model-R') throw new ProviderRateLimitedError()
        throw new Error(`unexpected ${model}`)
      }
      const outcome = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'recovery_handoff')
      if (outcome.kind !== 'recovery_handoff') throw new Error('unreachable')
      const targetId = outcome.targetSession.id
      const callsAfterRecovery = h.adapter.calls.length
      assert.equal(callsAfterRecovery, 2)
      // Now fail inside the target session: must fail normally with no new target.
      h.adapter.textImpl = async () => {
        throw new ProviderRateLimitedError()
      }
      // Direct completion in target (simulating manual retry) fails;
      // coordinator asked on target must not handoff.
      await assert.rejects(h.coordinator.ask({ workspaceId: h.workspaceId, sessionId: targetId }), /rate-limiting/i)
      // No additional recovery target was created from the target.
      // Total calls: 2 (first recovery) + 1 (target primary) = 3, no 4th.
      assert.equal(h.adapter.calls.length, 3)
      assert.equal(h.looplinks.listRecentFromSource(targetId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('absolute max Ask is 2 provider calls', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        return 'OK'
      }
      await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.ok(h.adapter.calls.length <= 2, `Ask calls ${h.adapter.calls.length} exceed 2`)
    } finally {
      closeHarness(h)
    }
  })

  it(' guards release on success and failure (no deadlock)', async () => {
    const h = openHarness()
    try {
      const sessionId = await seedAsk(h)
      setAutoOnce(h)
      h.adapter.textImpl = async (model) => {
        if (model === 'model-P') throw new ProviderRateLimitedError()
        return 'OK'
      }
      const outcome = await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId })
      assert.equal(h.guard.isActive(sessionId), false)
      if (outcome.kind === 'recovered') {
        assert.equal(h.guard.isActive(outcome.targetSession.id), false)
      }
      // Failure path also releases.
      const s2 = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: s2.id, content: 'Again.' })
      h.adapter.textImpl = async () => {
        throw new ProviderRateLimitedError()
      }
      // Force recovery failure by making R fail too.
      h.adapter.textImpl = async () => {
        throw new ProviderRateLimitedError()
      }
      await h.coordinator.ask({ workspaceId: h.workspaceId, sessionId: s2.id })
      assert.equal(h.guard.isActive(s2.id), false)
    } finally {
      closeHarness(h)
    }
  })
})
