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
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { AiBrainService } from './ai-brain-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import { ProviderModelUnavailableError } from './errors'
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

/**
 * Hosted Brain proof (no network, no Supabase, no keys, no BYOK
 * credential). With no legacy BYOK selection, Heart initializes to
 * the STARK Free default; an explicit `builtin:*` request model
 * overrides the Brain base while Worker routes stay
 * Heart-governed. Unknown builtin ids fail before any provider call.
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

class StarkScriptedAdapter implements AiProviderAdapter {
  readonly id = 'stark' as const
  readonly displayName = 'STARK'
  seenModels: string[] = []
  seenKeys: string[] = []
  nextPlan = ''

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'builtin:gpt-5.6-luna' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.seenModels.push(request.model)
    this.seenKeys.push(request.apiKey)
    return { text: 'unused' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.seenModels.push(request.model)
    this.seenKeys.push(request.apiKey)
    return { outputText: this.nextPlan }
  }
}

function openHostedBrain(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  brain: AiBrainService
  adapter: StarkScriptedAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-hosted-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, codingRows)
  const adapter = new StarkScriptedAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const session: HostedSessionProvider = {
    getAccessToken: async (): Promise<string> => 'ACCESS-MARKER'
  }
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry, {
    hostedSessionProvider: session
  })
  const brain = new AiBrainService(
    workspaces,
    codingRows,
    providerService,
    runs,
    new HeartService(new HeartRepository(db), providerRows, registry),
    { operationGuard: new AiOperationGuard() }
  )
  return { db, dir, workspaceId, sessions, brain, adapter }
}

function answerPlan(finalAnswer: string): string {
  return JSON.stringify({
    action: 'answer',
    planSummary: 'Direct answer planned.',
    finalAnswer,
    workerInstruction: null,
    workerProfile: null
  })
}

describe('hosted Brain routing', () => {
  it('runs the Free default through stark with the session token and no BYOK key', async () => {
    const harness = openHostedBrain()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Say hi.' })
      harness.adapter.nextPlan = answerPlan('HOSTED_OK')
      const result = await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(result.message.content, 'HOSTED_OK')
      assert.equal(result.run.status, 'completed')
      assert.ok(harness.adapter.seenModels.length >= 1)
      assert.ok(harness.adapter.seenModels.every((model) => model === 'builtin:gpt-5.6-luna'))
      assert.ok(harness.adapter.seenKeys.every((key) => key === 'ACCESS-MARKER'))
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('honors an explicit builtin request model for the Brain base', async () => {
    const harness = openHostedBrain()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Say hi.' })
      harness.adapter.nextPlan = answerPlan('HOSTED_KIMI')
      const result = await harness.brain.runBrain({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        model: 'builtin:kimi-k2.7-code'
      })
      assert.equal(result.message.content, 'HOSTED_KIMI')
      assert.ok(harness.adapter.seenModels.includes('builtin:kimi-k2.7-code'))
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown builtin ids before any provider call', async () => {
    const harness = openHostedBrain()
    try {
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Say hi.' })
      harness.adapter.nextPlan = answerPlan('UNREACHABLE')
      await assert.rejects(
        harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id, model: 'builtin:evil' }),
        ProviderModelUnavailableError
      )
      assert.equal(harness.adapter.seenModels.length, 0)
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
