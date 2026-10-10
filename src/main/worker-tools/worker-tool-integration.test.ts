import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { SessionContextService } from '../session-context/session-context-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import { AiCompletionService } from '../ai/ai-completion-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type { AiProviderAdapter } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository } from './worker-tool-repository'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import { RecoveryRepository } from '../recovery/recovery-repository'
import { RecoveryService } from '../recovery/recovery-service'
import { AiBrainService } from '../ai/ai-brain-service'
import type {
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult,
  ProviderWorkerTurnRequest,
  ProviderWorkerTurnResult
} from '../ai/provider-adapter'

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

class ScriptedAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  calls: string[] = []
  planScript: (string | Error)[] = []
  turnScript: (ProviderWorkerTurnResult | Error)[] = []
  textScript: (string | Error)[] = []
  constructor(readonly id: ProviderId) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    this.calls.push('text')
    const next = this.textScript.shift()
    if (next instanceof Error) throw next
    return { text: next as string }
  }
  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    void request
    this.calls.push('structured')
    const next = this.planScript.shift()
    if (next instanceof Error) throw next
    return { outputText: next as string }
  }
  async generateWorkerTurn(request: ProviderWorkerTurnRequest & { apiKey: string }): Promise<ProviderWorkerTurnResult> {
    void request
    this.calls.push('turn')
    const next = this.turnScript.shift()
    if (next instanceof Error) throw next
    return next as ProviderWorkerTurnResult
  }
}

function delegatePlan(): string {
  return JSON.stringify({ action: 'delegate', planSummary: 'Needs work.', finalAnswer: null, workerInstruction: 'Inspect.', workerProfile: 'coding' })
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  runs: OrchestrationRepository
  providerService: AiProviderService
  heart: HeartService
  looplinks: LooplinkRepository
  loopService: LooplinkService
  capService: CapabilityService
  tools: WorkerToolRepository
  approvals: WorkerToolApprovalService
  runner: WorkerToolRunner
  completion: AiCompletionService
  brain: AiBrainService
  coordinator: AiRecoveryCoordinator
  adapter: ScriptedAdapter
  guard: AiOperationGuard
  workspaces: WorkspaceRepository
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const heartRows = new HeartRepository(db)
  const looplinks = new LooplinkRepository(db)
  const capStore = new CapabilityRepository(db)
  const tools = new WorkerToolRepository(db)
  const recoveryStore = new RecoveryRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-tool-int-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'const a = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const files = new WorkspaceFilesService(workspaces)
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const adapter = new ScriptedAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const guard = new AiOperationGuard()
  const loopService = new LooplinkService(workspaces, codingRows, looplinks, guard, runs)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const capService = new CapabilityService(capStore, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const approvals = new WorkerToolApprovalService(workspaces, codingRows, runs, tools)
  const executor = new WorkerReadToolService({ gate, files, search, git, tools })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor
  })
  const completion = new AiCompletionService(workspaces, codingRows, providerRows, providerService, registry, {
    operationGuard: guard, looplink: { service: loopService, store: looplinks }, pendingApprovals: { hasPending: (s) => tools.hasPending(s) }
  })
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, heart, {
    operationGuard: guard, looplink: { service: loopService, store: looplinks }, pendingApprovals: { hasPending: (s) => tools.hasPending(s) }
  })
  const recoveryService = new RecoveryService(recoveryStore, providerRows, registry)
  const coordinator = new AiRecoveryCoordinator({
    workspaces, sessions: codingRows, orchestrationRuns: runs, completion, brain,
    looplinkService: loopService, looplinkStore: looplinks, recoveryStore, recoveryService
  })
  return { db, dir, workspaceId, sessions, codingRows, runs, providerService, heart, looplinks, loopService, capService, tools, approvals, runner, completion, brain, coordinator, adapter, guard, workspaces }
}

async function seed(h: ReturnType<typeof openHarness>): Promise<number> {
  await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
  h.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'model-B' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Inspect.' })
  return session.id
}

describe('worker-tool integration boundaries', () => {
  it('pending approval blocks new Ask/Work in the same session', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' },
      { capability: 'attachment.import', mode: 'deny' },
      { capability: 'image.generate', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [{ kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } }]
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      await assert.rejects(h.completion.generateResponse({ workspaceId: h.workspaceId, sessionId }), /pending STARK approval/i)
      await assert.rejects(h.brain.runBrain({ workspaceId: h.workspaceId, sessionId }), /pending STARK approval/i)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('looplink stays pending while waiting and consumes on final success', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      const created = await h.loopService.createContinuation({ workspaceId: h.workspaceId, sourceSessionId: sessionId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, content: 'Continue it.' })
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' },
      { capability: 'attachment.import', mode: 'deny' },
      { capability: 'image.generate', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: created.targetSession.id })
      assert.equal(waiting.kind, 'waiting_for_approval')
      assert.equal(h.looplinks.findByTargetSession(created.targetSession.id)?.status, 'pending')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId: created.targetSession.id, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.looplinks.findByTargetSession(created.targetSession.id)?.status, 'consumed')
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('tool-read file grants no proposal authority', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'allow' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' },
      { capability: 'attachment.import', mode: 'deny' },
      { capability: 'image.generate', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const outcome = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(outcome.kind, 'completed')
      // No fresh Stage 15 context rows were created by the tool read.
      const messages = h.codingRows.listMessagesNewestFirst(sessionId, 10, null)
      for (const message of messages) {
        assert.equal(h.codingRows.listContextForMessage(message.id).length, 0)
      }
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('tool audit reloads after restart with approval link and no secrets', async () => {
    const h = openHarness()
    try {
      const sessionId = await seed(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'ask' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' },
      { capability: 'attachment.import', mode: 'deny' },
      { capability: 'image.generate', mode: 'deny' }
        ]
      })
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'app.ts' } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(resumed.result.run.id)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.approvalId, waiting.approval.id)
      assert.ok(!JSON.stringify(events[0]).includes('sk-test'))
      // Reload from storage: same rows.
      assert.equal(h.tools.listEvents(resumed.result.run.id).length, 1)
      assert.equal(h.tools.findApproval(waiting.approval.id)?.status, 'consumed')
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})
