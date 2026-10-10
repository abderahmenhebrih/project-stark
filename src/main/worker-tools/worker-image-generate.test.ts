import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { getUserVersion } from '../database/migrations/index'
import { AiProviderRepository } from '../database/repositories/ai-provider-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { HeartRepository } from '../heart/heart-repository'
import { HeartService } from '../heart/heart-service'
import { LooplinkRepository } from '../looplink/looplink-repository'
import { LooplinkService } from '../looplink/looplink-service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { ChatAttachmentService } from '../chat-attachments/service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { AiProviderService } from '../ai/ai-provider-service'
import type { CredentialProtector } from '../ai/credential-protector'
import type {
  AiProviderAdapter,
  ProviderGeneratedImage,
  ProviderImageGenerationRequest,
  ProviderWorkerTurnResult
} from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { providerSupportsImageGeneration } from '../../shared/ai/image-capabilities'
import { buildChatAttachmentSection } from '../ai/ai-attachment-resolver'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { legalModesFor } from '../capabilities/capability-registry'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { AttachmentImportService } from '../attachment-import/attachment-import-service'
import { ImageGenerationService } from '../image-generation/image-generation-service'
import { WorkerToolRepository, serializeToolArgs } from './worker-tool-repository'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { capabilityForTool, workerToolSchemas, approvalSummaryFor } from './worker-tool-registry'

function pngBytes(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)])
}

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

class ScriptedImageAdapter implements AiProviderAdapter {
  readonly displayName = 'Fake'
  planScript: (string | Error)[] = []
  turnScript: (ProviderWorkerTurnResult | Error)[] = []
  textScript: (string | Error)[] = []
  imageScript: ((share: number) => ProviderGeneratedImage[] | Error)[] = []
  imageCalls: (ProviderImageGenerationRequest & { readonly apiKey: string })[] = []
  constructor(readonly id: ProviderId) {}
  async listModels(): Promise<readonly ProviderModel[]> {
    return [{ id: 'm' }]
  }
  async generateText(request: unknown): Promise<{ text: string }> {
    void request
    const next = this.textScript.shift()
    if (next instanceof Error) throw next
    return { text: next as string }
  }
  async generateStructured(request: unknown): Promise<{ outputText: string }> {
    void request
    const next = this.planScript.shift()
    if (next instanceof Error) throw next
    return { outputText: next as string }
  }
  async generateWorkerTurn(request: unknown): Promise<ProviderWorkerTurnResult> {
    void request
    const next = this.turnScript.shift()
    if (next instanceof Error) throw next
    return next as ProviderWorkerTurnResult
  }
  async generateImages(
    request: ProviderImageGenerationRequest & { readonly apiKey: string }
  ): Promise<readonly ProviderGeneratedImage[]> {
    this.imageCalls.push(request)
    const next = this.imageScript.shift()
    if (next === undefined) throw new Error('image script exhausted (no retry expected)')
    const produced = next(request.count)
    if (produced instanceof Error) throw produced
    return produced
  }
}

function delegatePlan(): string {
  return JSON.stringify({ action: 'delegate', planSummary: 'Needs images.', finalAnswer: null, workerInstruction: 'Generate the hero image.', workerProfile: 'general' })
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  sessions: CodingSessionService
  attachments: ChatAttachmentService
  store: CodingSessionRepository
  heart: HeartService
  capService: CapabilityService
  tools: WorkerToolRepository
  executor: WorkerReadToolService
  runner: WorkerToolRunner
  transactions: ChangeTransactionService
  adapter: ScriptedImageAdapter
  imports: AttachmentImportService
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
  const txRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-image-tool-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, codingRows)
  const sessions = new CodingSessionService(workspaces, codingRows, { attachmentService: attachments })
  const adapter = new ScriptedImageAdapter('openai')
  const registry = new ProviderRegistry()
  registry.register(adapter)
  const providerService = new AiProviderService(providerRows, new FakeProtector(), registry)
  const heart = new HeartService(heartRows, providerRows, registry)
  const guard = new AiOperationGuard()
  const loopService = new LooplinkService(workspaces, codingRows, looplinks, guard, runs)
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const capService = new CapabilityService(capStore, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const approvals = new WorkerToolApprovalService(workspaces, codingRows, runs, tools)
  const writer = new WorkspaceFileWriteService(workspaces)
  const imports = new AttachmentImportService(workspaces, codingRows, attachments, txRows, setRows)
  const transactions = new ChangeTransactionService(workspaces, txRows, writer, Date.now, imports)
  const changeSets = new ChangeSetService(workspaces, setRows, txRows)
  const images = new ImageGenerationService({ providerService, registry, attachments, heart })
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets, attachmentImports: imports, images })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor, attachments
  })
  return { db, dir, root, workspaceId, sessions, attachments, store: codingRows, heart, capService, tools, executor, runner, transactions, adapter, imports }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

function imagePolicies(mode: 'ask' | 'deny'): { capability: string; mode: string }[] {
  return [
    { capability: 'workspace.read', mode: 'deny' },
    { capability: 'workspace.search', mode: 'deny' },
    { capability: 'git.read', mode: 'deny' },
    { capability: 'change.propose', mode: 'deny' },
    { capability: 'attachment.import', mode: mode === 'ask' ? 'ask' : 'deny' },
    { capability: 'image.generate', mode },
    { capability: 'terminal.execute', mode: 'deny' },
    { capability: 'runtime.observe', mode: 'deny' },
    { capability: 'preview.inspect', mode: 'deny' }
  ]
}

describe('image_generate tool', () => {
  it('registers the exact tool schema with ASK-only capability', () => {
    assert.equal(capabilityForTool('image_generate'), 'image.generate')
    assert.deepEqual([...legalModesFor('image.generate')], ['deny', 'ask'])
    const schema = workerToolSchemas().find((entry) => entry.name === 'image_generate')
    assert.ok(schema !== undefined)
    const parameters = schema.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
    assert.deepEqual([...parameters.required].sort(), ['count', 'prompt'])
    assert.equal(parameters.additionalProperties, false)
    const count = parameters.properties['count'] as { minimum: number; maximum: number }
    assert.equal(count.minimum, 1)
    assert.equal(count.maximum, 4)
    assert.ok(schema.description.includes('chat attachment'))
  })

  it('parses prompt/count with no provider URL, credential, or path authority', () => {
    const parsed = parseWorkerToolRequest('image_generate', { prompt: 'a hero', count: 2 })
    assert.deepEqual(parsed, { tool: 'image_generate', prompt: 'a hero', count: 2 })
    assert.throws(() => parseWorkerToolRequest('image_generate', { prompt: 'x', count: 5 }))
    assert.throws(() => parseWorkerToolRequest('image_generate', { prompt: '', count: 1 }))
    assert.throws(() => parseWorkerToolRequest('image_generate', { prompt: 'x', count: 1, providerUrl: 'https://evil.example/' }))
    assert.throws(() => parseWorkerToolRequest('image_generate', { prompt: 'x', count: 1, apiKey: 'sk-x' }))
    assert.throws(() => parseWorkerToolRequest('image_generate', { prompt: 'x', count: 1, destination: 'public/x.png' }))
    const summary = approvalSummaryFor('image_generate', { prompt: 'x', count: 2 })
    assert.ok(summary.includes('Generate 2 images'))
  })

  it('deny persists a denied event with no images and no store rows', async () => {
    const h = openHarness()
    try {
      await h.sessions.createSession({ workspaceId: h.workspaceId }).then(async (session) => {
        await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Generate a hero.' })
        h.capService.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: imagePolicies('deny') as never })
        const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, session.id, 1).lastInsertRowid)
        const result = await h.executor.execute({
          workspaceId: h.workspaceId, sessionId: session.id, runId, tool: 'image_generate',
          args: { tool: 'image_generate', prompt: 'a hero', count: 1 } as never,
          argsJson: serializeToolArgs({ prompt: 'a hero', count: 1 }),
          approvalId: null, now: 10
        })
        assert.equal(result.status, 'denied')
        assert.equal(h.adapter.imageCalls.length, 0)
        const count: unknown = h.db.prepare('SELECT COUNT(*) AS n FROM chat_attachments').get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
      })
    } finally {
      closeHarness(h)
    }
  })

  it('ask parks with cost copy, approve generates once, assistant message carries ordered images', async () => {
    const h = openHarness()
    try {
      const providerRows = new AiProviderRepository(h.db)
      providerRows.setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
      providerRows.setSelectedModel('openai', 'gpt-4o', 1)
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-image-1' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      assert.ok(providerSupportsImageGeneration('openai', 'gpt-image-1'))
      const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Generate 2 variations.' })
      h.capService.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: imagePolicies('ask') as never })
      const first = pngBytes('first-image-bytes')
      const second = pngBytes('second-image-bytes')
      h.adapter.imageScript = [
        (share) => [first, second].slice(0, share).map((bytes) => ({ bytes: new Uint8Array(bytes), mimeType: 'image/png' }))
      ]
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'image_generate', args: { prompt: 'a hero', count: 2 } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['Here are your images.']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: session.id })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'image_generate')
      assert.equal(waiting.approval.capability, 'image.generate')
      assert.ok(waiting.approval.summary.includes('Generate 2 images'), 'approval discloses the action')
      assert.ok(waiting.approval.summary.includes('credits') || waiting.approval.summary.includes('quota'), 'approval discloses cost')
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')))
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId: session.id, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      // At-most-once: the consumed approval cannot run again.
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId: session.id, approvalId: waiting.approval.id }))
      assert.equal(h.adapter.imageCalls.length, 1)
      const message = resumed.result.message
      const links = h.store.listAttachmentsForMessage(message.id)
      assert.equal(links.length, 2)
      assert.ok(links.every((link) => link.kind === 'image'))
      assert.equal(links[0]?.sha256, createHash('sha256').update(first).digest('hex'))
      assert.equal(links[1]?.sha256, createHash('sha256').update(second).digest('hex'))
      // Ordering is stable: "the second image" resolves to links[1].
      const secondId = links[1]?.attachmentId ?? ''
      assert.ok(secondId !== '' && secondId !== links[0]?.attachmentId)
      // Generated images render and survive reload: message hydration
      // carries the same attachments.
      const page = await h.sessions.listMessages({ workspaceId: h.workspaceId, sessionId: session.id, beforeMessageId: undefined })
      const assistant = page.messages.find((entry) => entry.id === message.id)
      assert.equal(assistant?.attachments?.length, 2)
      // No direct workspace write: the project is untouched.
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')))
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 1\n')
      // The second image feeds later AI vision through the existing resolver.
      const section = buildChatAttachmentSection({ sessions: h.store, attachments: h.attachments, messageId: message.id, providerId: 'openai', model: 'gpt-4o' })
      assert.equal(section.payloads.length, 2)
      assert.equal(section.payloads[1]?.kind, 'image')
    } finally {
      closeHarness(h)
    }
  })

  it('second generated image imports through attachment_import with binary review and exact bytes', async () => {
    const h = openHarness()
    try {
      const providerRows = new AiProviderRepository(h.db)
      providerRows.setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
      providerRows.setSelectedModel('openai', 'gpt-4o', 1)
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-image-1' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Generate 2 variations.' })
      h.capService.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: imagePolicies('ask') as never })
      const first = pngBytes('mobility-first')
      const second = pngBytes('mobility-second')
      h.adapter.imageScript = [
        (share) => [first, second].slice(0, share).map((bytes) => ({ bytes: new Uint8Array(bytes), mimeType: 'image/png' }))
      ]
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'image_generate', args: { prompt: 'a hero', count: 2 } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['Here are your images.']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId: session.id })
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId: session.id, approvalId: waiting.approval.id })
      if (resumed.kind !== 'completed') throw new Error('unreachable')
      const links = h.store.listAttachmentsForMessage(resumed.result.message.id)
      const secondId = links[1]?.attachmentId ?? ''
      assert.ok(secondId !== '')
      // Workspace unchanged before Accept; Reject leaves it unchanged.
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, session.id, 1).lastInsertRowid)
      const proposal = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId: session.id, runId, tool: 'attachment_import',
        args: { tool: 'attachment_import', imports: [{ attachmentId: secondId, proposedRelativePath: 'public/hero.png' }] } as never,
        argsJson: serializeToolArgs({ imports: [{ attachmentId: secondId, proposedRelativePath: 'public/hero.png' }] }),
        approvalId: null, now: 20
      })
      assert.equal(proposal.status, 'succeeded')
      const payload = JSON.parse(proposal.payload) as { status: string; kind: string; transactionId: number }
      assert.equal(payload.status, 'proposal_created')
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')), 'proposal never writes')
      const rejected = await h.transactions.rejectTransaction({ transactionId: payload.transactionId })
      assert.equal(rejected.status, 'rejected')
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')), 'Reject leaves the workspace unchanged')
      const secondProposal = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId: session.id, runId, tool: 'attachment_import',
        args: { tool: 'attachment_import', imports: [{ attachmentId: secondId, proposedRelativePath: 'public/hero.png' }] } as never,
        argsJson: serializeToolArgs({ imports: [{ attachmentId: secondId, proposedRelativePath: 'public/hero.png' }] }),
        approvalId: null, now: 21
      })
      const payload2 = JSON.parse(secondProposal.payload) as { status: string; kind: string; transactionId: number }
      const applied = await h.transactions.acceptTransaction({ transactionId: payload2.transactionId })
      assert.equal(applied.status, 'applied')
      assert.ok(readFileSync(join(h.root, 'public', 'hero.png')).equals(second), 'Accept imports exact generated bytes')
    } finally {
      closeHarness(h)
    }
  })

  it('fixed incapable routes fail the tool bounded with no images', async () => {
    const h = openHarness()
    try {
      const providerRows = new AiProviderRepository(h.db)
      providerRows.setEncryptedCredential('openai', Buffer.from('fake:sk-test', 'utf8'), 1)
      providerRows.setSelectedModel('openai', 'gpt-4o', 1)
      h.heart.updateConfig({
        workerMode: 'fixed',
        brain: { providerId: 'openai', model: 'gpt-4o' },
        workerFixed: { providerId: 'openai', model: 'gpt-4o' },
        workerDefault: null,
        workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
      })
      const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Generate a hero.' })
      h.capService.updateConfig({ workspaceId: h.workspaceId, enabled: true, policies: imagePolicies('ask') as never })
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, session.id, 1).lastInsertRowid)
      const result = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId: session.id, runId, tool: 'image_generate',
        args: { tool: 'image_generate', prompt: 'a hero', count: 1 } as never,
        argsJson: serializeToolArgs({ prompt: 'a hero', count: 1 }),
        approvalId: null, now: 10
      })
      assert.equal(result.status, 'failed')
      assert.ok((result.reason ?? '').includes('cannot generate images'))
      assert.equal(h.adapter.imageCalls.length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('stays on schema v19 with no migration 020 and leaves extensions untouched', async () => {
    const h = openHarness()
    try {
      assert.equal(getUserVersion(h.db), 19)
      const { readdirSync } = await import('node:fs')
      const { join: joinPath } = await import('node:path')
      const files = readdirSync(joinPath(process.cwd(), 'src', 'main', 'database', 'migrations'))
      assert.ok(!files.some((file) => file.startsWith('020-')), 'no migration 020')
      const { readFileSync: read } = await import('node:fs')
      for (const file of [
        'image-generation/image-generation-service.ts',
        'image-generation/validation.ts',
        'voice/voice-transcription-service.ts',
        'chat-attachments/service.ts'
      ]) {
        const source = read(joinPath(process.cwd(), 'src', 'main', file), 'utf8')
        assert.ok(!source.includes('extension-host'), `${file} must not touch the extension host`)
        assert.ok(!source.includes('ExtensionHost'), `${file} must not touch the extension host`)
      }
    } finally {
      closeHarness(h)
    }
  })

  it('Brain stays tool-free of image_generate', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const brain = readFileSync(joinPath(process.cwd(), 'src', 'main', 'ai', 'ai-brain-service.ts'), 'utf8')
    assert.ok(!brain.includes('image_generate'), 'Brain must not name the image tool')
  })
})
