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
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiCodeProposalService } from './ai-code-proposal-service'
import { AiMultiFileProposalService } from './ai-multi-file-proposal-service'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type { AiProviderAdapter, ProviderGenerateRequest, ProviderGenerateResult, ProviderStructuredRequest, ProviderStructuredResult } from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'
import { ProviderTimeoutError } from './errors'

/**
 * Proposal LoopLink execution audit proof (no network, no keys).
 * Single and Change Set proposals each write one orchestration run
 * with a single `proposal` step when runs are wired: winning model
 * plus attempts/failover metadata, completed only after the pending
 * transaction/set exists. Failures leave a failed run with a failed
 * step and no transaction. Legacy harnesses without runs behave
 * exactly as before.
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

class ScriptedOpenAi implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  readonly calls: string[] = []
  constructor(private readonly behavior: Map<string, { structured: string } | { error: unknown }>) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }]
  }
  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    void request
    return { text: 'reply' }
  }
  async generateStructured(request: ProviderStructuredRequest & { readonly apiKey: string }): Promise<ProviderStructuredResult> {
    this.calls.push(request.model)
    const scripted = this.behavior.get(request.model)
    if (scripted !== undefined && 'error' in scripted) {
      throw scripted.error
    }
    if (scripted !== undefined && 'structured' in scripted) {
      return { outputText: scripted.structured, usage: null }
    }
    return { outputText: JSON.stringify({ summary: 'single ok', proposedContent: 'changed single\n' }), usage: null }
  }
}

const APP_TS = 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n'
const OTHER_TS = 'line one\nline two\n'

function openHarness(behavior: Map<string, { structured: string } | { error: unknown }>): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  context: SessionContextService
  sessions: CodingSessionService
  codingRows: CodingSessionRepository
  runs: OrchestrationRepository
  proposals: AiCodeProposalService
  multi: AiMultiFileProposalService
  providerService: AiProviderService
  adapter: ScriptedOpenAi
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const changeRows = new ChangeTransactionRepository(db)
  const changeSetRows = new ChangeSetRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const writer = new WorkspaceFileWriteService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-propose-audit-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), APP_TS)
  writeFileSync(join(root, 'other.ts'), OTHER_TS)
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const transactions = new ChangeTransactionService(workspaces, changeRows, writer)
  const changeSets = new ChangeSetService(workspaces, changeSetRows, changeRows)
  const adapter = new ScriptedOpenAi(behavior)
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const guard = new AiOperationGuard()
  const runs = new OrchestrationRepository(db)
  const proposals = new AiCodeProposalService(workspaces, codingRows, providerRows, providerService, registry, files, transactions, {
    operationGuard: guard,
    runs
  })
  const multi = new AiMultiFileProposalService(workspaces, codingRows, providerRows, providerService, registry, files, changeSets, {
    operationGuard: guard,
    runs
  })
  return { db, dir, workspaceId, context, sessions, codingRows, runs, proposals, multi, providerService, adapter }
}

function closeHarness(harness: { db: DatabaseSync; dir: string }): void {
  harness.db.close()
  rmSync(harness.dir, { recursive: true, force: true })
}

async function openSingleSession(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
  await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Change this.', context: [whole] })
  return session.id
}

async function openMultiSession(harness: ReturnType<typeof openHarness>): Promise<number> {
  await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
  const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
  const first = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
  const second = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'other.ts' })
  await harness.sessions.sendUserMessage({
    workspaceId: harness.workspaceId,
    sessionId: session.id,
    content: 'Change both.',
    context: [first, second]
  })
  return session.id
}

describe('single proposal execution audit', () => {
  it('legacy path records winner with attempts=1 and a completed run', async () => {
    const harness = openHarness(new Map())
    try {
      const sessionId = await openSingleSession(harness)
      const result = await harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId, effort: 'medium' })
      assert.equal(result.transaction.status, 'pending')
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'completed')
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.kind, 'proposal')
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.providerId, 'openai')
      assert.equal(audit?.model, 'gpt-4o')
      assert.equal(audit?.attempts, 1)
      assert.equal(audit?.failoverNote, null)
      assert.deepEqual([...(audit?.attemptedModels ?? [])], ['gpt-4o'])
      assert.equal(audit?.requestedEffort, 'medium')
    } finally {
      closeHarness(harness)
    }
  })

  it('chain failover records the winner with attempts', async () => {
    const harness = openHarness(
      new Map([
        ['gpt-4o', { error: new ProviderTimeoutError() }],
        ['gpt-4o-mini', { structured: JSON.stringify({ summary: 'mini ok', proposedContent: 'changed mini\n' }) }]
      ])
    )
    try {
      const sessionId = await openSingleSession(harness)
      // Scripted mini success: default structured output is single-shaped.
      const result = await harness.proposals.proposeFileChange({
        workspaceId: harness.workspaceId,
        sessionId,
        brainModels: ['openai:gpt-4o', 'openai:gpt-4o-mini']
      })
      assert.equal(result.transaction.status, 'pending')
      assert.deepEqual(harness.adapter.calls, ['gpt-4o', 'gpt-4o-mini'])
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.model, 'gpt-4o-mini')
      assert.equal(audit?.attempts, 2)
      assert.deepEqual([...(audit?.attemptedModels ?? [])], ['openai:gpt-4o', 'openai:gpt-4o-mini'])
      assert.ok(audit?.failoverNote !== null && audit.failoverNote.includes('openai:gpt-4o-mini'))
    } finally {
      closeHarness(harness)
    }
  })

  it('provider failure leaves a failed run with no transaction', async () => {
    const harness = openHarness(new Map([['gpt-4o', { error: new ProviderTimeoutError() }]]))
    try {
      const sessionId = await openSingleSession(harness)
      await assert.rejects(
        harness.proposals.proposeFileChange({ workspaceId: harness.workspaceId, sessionId }),
        ProviderTimeoutError
      )
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'failed')
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.status, 'failed')
    } finally {
      closeHarness(harness)
    }
  })
})

describe('multi proposal execution audit', () => {
  it('legacy path records a completed run linked to no message', async () => {
    const harness = openHarness(
      new Map([
        [
          'gpt-4o',
          {
            structured: JSON.stringify({
              summary: 'multi ok',
              changes: [
                { targetId: 'T1', summary: 'first', proposedContent: 'changed app\n' },
                { targetId: 'T2', summary: 'second', proposedContent: 'changed other\n' }
              ]
            })
          }
        ]
      ])
    )
    try {
      const sessionId = await openMultiSession(harness)
      const result = await harness.multi.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId })
      assert.ok(result.changeSet.id > 0)
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'completed')
      assert.equal(recent[0]?.finalMessageId, null)
      const steps = harness.runs.findSteps(recent[0]?.id ?? -1)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.kind, 'proposal')
      const models = harness.runs.findStepModels(recent[0]?.id ?? -1)
      const audit = models.get(steps[0]?.id ?? -1)
      assert.equal(audit?.providerId, 'openai')
      assert.equal(audit?.model, 'gpt-4o')
      assert.equal(audit?.attempts, 1)
    } finally {
      closeHarness(harness)
    }
  })

  it('provider failure leaves a failed run with no change set', async () => {
    const harness = openHarness(new Map([['gpt-4o', { error: new ProviderTimeoutError() }]]))
    try {
      const sessionId = await openMultiSession(harness)
      await assert.rejects(
        harness.multi.proposeChangeSet({ workspaceId: harness.workspaceId, sessionId }),
        ProviderTimeoutError
      )
      const recent = harness.runs.listRecentForSession(sessionId, 5)
      assert.equal(recent.length, 1)
      assert.equal(recent[0]?.status, 'failed')
    } finally {
      closeHarness(harness)
    }
  })
})
