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
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { SessionContextService } from '../session-context/session-context-service'
import { AiBrainService } from './ai-brain-service'
import { AiOperationGuard } from './ai-operation-guard'
import { AiProviderService } from './ai-provider-service'
import type { CredentialProtector } from './credential-protector'
import type {
  AiProviderAdapter,
  ProviderContextMessage,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStructuredRequest,
  ProviderStructuredResult
} from './provider-adapter'
import { ProviderRegistry } from './provider-adapter'
import type { ProviderModel } from '../../shared/providers/types'

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

interface SeenStructured {
  readonly instructions: string
  readonly messages: readonly ProviderContextMessage[]
}

interface SeenText {
  readonly instructions: string
  readonly messages: readonly ProviderContextMessage[]
}

class ProbingAdapter implements AiProviderAdapter {
  readonly id = 'openai' as const
  readonly displayName = 'OpenAI'
  structured: SeenStructured[] = []
  texts: SeenText[] = []
  private textPhase: 'worker' | 'synthesis' = 'worker'

  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'gpt-4o' }]
  }

  async generateText(request: ProviderGenerateRequest & { apiKey: string }): Promise<ProviderGenerateResult> {
    this.texts.push({ instructions: request.instructions, messages: request.messages })
    if (this.textPhase === 'worker') {
      this.textPhase = 'synthesis'
      return { text: 'worker analysis' }
    }
    return { text: 'final answer' }
  }

  async generateStructured(request: ProviderStructuredRequest & { apiKey: string }): Promise<ProviderStructuredResult> {
    this.structured.push({ instructions: request.instructions, messages: request.messages })
    return {
      outputText: JSON.stringify({
        action: 'delegate',
        planSummary: 'Needs analysis.',
        finalAnswer: null,
        workerInstruction: 'Analyze the notes.',
        workerProfile: 'coding'
      })
    }
  }
}

const NOTE_BODY = 'Remember the retry budget.'
const FILE_BODY = 'const alpha = 1\n'

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessions: CodingSessionService
  context: SessionContextService
  brain: AiBrainService
  providerService: AiProviderService
  adapter: ProbingAdapter
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const providerRows = new AiProviderRepository(db)
  const runs = new OrchestrationRepository(db)
  const files = new WorkspaceFilesService(workspaces)
  const dir = mkdtempSync(join(tmpdir(), 'stark-brain-context-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), FILE_BODY)
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 }).id
  const context = new SessionContextService(workspaces, files)
  const sessions = new CodingSessionService(workspaces, codingRows, { contextService: context })
  const adapter = new ProbingAdapter()
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const brain = new AiBrainService(workspaces, codingRows, providerService, runs, new HeartService(new HeartRepository(db), providerRows, registry), {
    operationGuard: new AiOperationGuard()
  })
  return { db, dir, workspaceId, sessions, context, brain, providerService, adapter }
}

describe('brain context boundary', () => {
  it('provider input contains only history, user content, explicit context, and run artifacts', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      const whole = await harness.context.prepareWholeFile({ workspaceId: harness.workspaceId, relativePath: 'app.ts' })
      const note = await harness.context.prepareNote({ workspaceId: harness.workspaceId, content: NOTE_BODY })
      await harness.sessions.sendUserMessage({
        workspaceId: harness.workspaceId,
        sessionId: session.id,
        content: 'Review this code.',
        context: [whole, note]
      })
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      assert.equal(harness.adapter.structured.length, 1)
      const planInput = harness.adapter.structured[0]?.messages.map((entry) => entry.content).join('\n') ?? ''
      assert.ok(planInput.includes('Review this code.'), 'user content travels')
      assert.ok(planInput.includes(NOTE_BODY), 'manual notes remain data')
      assert.ok(planInput.includes(FILE_BODY.trim()), 'attached file snippets remain data')
      assert.ok(!planInput.includes('sk-test'), 'no credentials in input')
      // Worker input carries the same explicit context plus the task.
      const workerInput = harness.adapter.texts[0]?.messages.map((entry) => entry.content).join('\n') ?? ''
      assert.ok(workerInput.includes('Analyze the notes.') || workerInput.includes('delegated task'), 'task travels')
      assert.ok(workerInput.includes(NOTE_BODY), 'explicit context travels to the worker')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('worker output never enters an instruction parameter', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      const synthesis = harness.adapter.texts[1]
      assert.ok(synthesis !== undefined)
      assert.ok(!synthesis.instructions.includes('worker analysis'), 'worker output stays out of instructions')
      assert.ok(
        synthesis.messages.some((entry) => entry.role === 'user' && entry.content.includes('worker analysis')),
        'worker output travels as user-role data'
      )
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  it('no workspace file reads happen outside explicit persisted context', async () => {
    const harness = openHarness()
    try {
      await harness.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
      await harness.providerService.setModel({ providerId: 'openai', model: 'gpt-4o' })
      const session = await harness.sessions.createSession({ workspaceId: harness.workspaceId })
      await harness.sessions.sendUserMessage({ workspaceId: harness.workspaceId, sessionId: session.id, content: 'Hi.' })
      await harness.brain.runBrain({ workspaceId: harness.workspaceId, sessionId: session.id })
      const allContent =
        harness.adapter.structured.flatMap((call) => call.messages.map((entry) => entry.content)).join('\n') +
        harness.adapter.texts.flatMap((call) => call.messages.map((entry) => entry.content)).join('\n')
      assert.ok(!allContent.includes(FILE_BODY.trim()), 'unattached file content never travels')
    } finally {
      harness.db.close()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })
})
