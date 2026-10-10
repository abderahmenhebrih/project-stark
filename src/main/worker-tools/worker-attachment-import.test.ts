import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
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
import type { AiProviderAdapter, ProviderWorkerTurnResult } from '../ai/provider-adapter'
import { ProviderRegistry } from '../ai/provider-adapter'
import type { ProviderId, ProviderModel } from '../../shared/providers/types'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { AttachmentImportService } from '../attachment-import/attachment-import-service'
import { WorkerToolRepository, serializeToolArgs } from './worker-tool-repository'
import { WorkerToolApprovalService } from './worker-tool-approval-service'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { WorkerToolRunner } from './worker-tool-runner'
import { capabilityForTool } from './worker-tool-registry'

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
  planScript: (string | Error)[] = []
  turnScript: (ProviderWorkerTurnResult | Error)[] = []
  textScript: (string | Error)[] = []
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
}

function delegatePlan(): string {
  return JSON.stringify({ action: 'delegate', planSummary: 'Needs work.', finalAnswer: null, workerInstruction: 'Use the attached image.', workerProfile: 'coding' })
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  root: string
  workspaceId: number
  sessions: CodingSessionService
  attachments: ChatAttachmentService
  store: CodingSessionRepository
  providerService: AiProviderService
  heart: HeartService
  capService: CapabilityService
  tools: WorkerToolRepository
  executor: WorkerReadToolService
  runner: WorkerToolRunner
  transactions: ChangeTransactionService
  changeSets: ChangeSetService
  txRows: ChangeTransactionRepository
  setRows: ChangeSetRepository
  adapter: ScriptedAdapter
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
  const dir = mkdtempSync(join(tmpdir(), 'stark-attach-tool-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'public'), { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const attachments = new ChatAttachmentService(join(dir, 'attachments'), workspaces, codingRows)
  const sessions = new CodingSessionService(workspaces, codingRows, { attachmentService: attachments })
  const adapter = new ScriptedAdapter('openai')
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
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, transactions, changeSets, attachmentImports: imports })
  const runner = new WorkerToolRunner({
    workspaces, sessions: codingRows, providerService, runs, heart, guard,
    looplink: { service: loopService, store: looplinks },
    gate, files, search, git, tools, approvals, executor, attachments
  })
  return { db, dir, root, workspaceId, sessions, attachments, store: codingRows, providerService, heart, capService, tools, executor, runner, transactions, changeSets, txRows, setRows, adapter }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepngdata')])
}

async function seed(h: ReturnType<typeof openHarness>): Promise<{ sessionId: number; attachmentId: string }> {
  await h.providerService.saveCredential({ providerId: 'openai', apiKey: 'sk-test' })
  await h.providerService.setModel({ providerId: 'openai', model: 'model-LEGACY' })
  h.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'model-B' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
  const source = join(h.dir, 'hero.png')
  writeFileSync(source, pngBytes())
  const [stored] = await h.attachments.chooseAttachments(h.workspaceId, [source])
  if (stored === undefined) throw new Error('unreachable')
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Use this as the hero image.', attachments: [stored.id] })
  return { sessionId: session.id, attachmentId: stored.id }
}

function allowImport(h: ReturnType<typeof openHarness>): void {
  // attachment.import never allows persistent allow (binary-write
  // policy) — executor creation tests run through the approved path,
  // mirroring the production ask-only flow.
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'deny' },
      { capability: 'attachment.import', mode: 'ask' },
      { capability: 'image.generate', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

function useVisionWorker(h: ReturnType<typeof openHarness>): void {
  // The seeded run carries an image attachment: the fixed Worker
  // assignment must be vision-capable (otherwise routing fails
  // explicitly — covered by the heart routing tests).
  h.heart.updateConfig({
    workerMode: 'fixed',
    brain: { providerId: 'openai', model: 'model-A' },
    workerFixed: { providerId: 'openai', model: 'gpt-4o' },
    workerDefault: null,
    workerRoutes: { general: null, coding: null, reasoning: null, fast: null }
  })
}

function askImport(h: ReturnType<typeof openHarness>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'deny' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'deny' },
      { capability: 'attachment.import', mode: 'ask' },
      { capability: 'image.generate', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

function allowProposeAskImport(h: ReturnType<typeof openHarness>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId, enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'allow' },
      { capability: 'attachment.import', mode: 'ask' },
      { capability: 'image.generate', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'deny' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

describe('attachment_import tool', () => {
  it('parses opaque IDs plus destinations with no path authority', () => {
    const parsed = parseWorkerToolRequest('attachment_import', {
      imports: [{ attachmentId: 'a'.repeat(32), proposedRelativePath: 'public/hero.png' }]
    })
    assert.deepEqual(parsed, { tool: 'attachment_import', imports: [{ attachmentId: 'a'.repeat(32), proposedRelativePath: 'public/hero.png' }] })
    assert.equal(capabilityForTool('attachment_import'), 'attachment.import')
  })

  it('approved execution creates one pending binary transaction with the workspace unchanged', async () => {
    const h = openHarness()
    try {
      const { sessionId, attachmentId } = await seed(h)
      allowImport(h)
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      // Ask-only tools never execute through the direct path.
      await assert.rejects(
        h.executor.execute({
          workspaceId: h.workspaceId, sessionId, runId, tool: 'attachment_import',
          args: { tool: 'attachment_import', imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] } as never,
          argsJson: serializeToolArgs({ imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] }),
          approvalId: null, now: 10
        }),
        /approval required/
      )
      // The approved path (post human approval) creates the proposal.
      const result = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'attachment_import',
        args: { tool: 'attachment_import', imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] } as never,
        argsJson: serializeToolArgs({ imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] }),
        approvalId: null, now: 11
      })
      assert.equal(result.status, 'succeeded')
      const payload = JSON.parse(result.payload) as { status: string; kind: string; transactionId: number; files: { summary: string }[] }
      assert.equal(payload.status, 'proposal_created')
      assert.equal(payload.kind, 'single')
      assert.ok(payload.files[0]?.summary.includes('public/hero.png'))
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')), 'proposal never writes')
      const tx = await h.transactions.getTransaction({ transactionId: payload.transactionId })
      assert.equal(tx.status, 'pending')
      assert.ok(tx.files[0]?.binaryImport !== undefined)
    } finally {
      closeHarness(h)
    }
  })

  it('deny persists a denied event with no transaction', async () => {
    const h = openHarness()
    try {
      const { sessionId, attachmentId } = await seed(h)
      askImport(h)
      h.capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'deny' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'attachment.import', mode: 'deny' },
          { capability: 'image.generate', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' },
          { capability: 'runtime.observe', mode: 'deny' },
          { capability: 'preview.inspect', mode: 'deny' }
        ]
      })
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'attachment_import',
        args: { tool: 'attachment_import', imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] } as never,
        argsJson: serializeToolArgs({ imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] }),
        approvalId: null, now: 10
      })
      assert.equal(result.status, 'denied')
      assert.ok((result.reason ?? '').includes('not allowed'))
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('unknown attachments and unsafe destinations fail bounded', async () => {
    const h = openHarness()
    try {
      const { sessionId, attachmentId } = await seed(h)
      allowImport(h)
      const runId = Number(h.db.prepare("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)").run(h.workspaceId, sessionId, 1).lastInsertRowid)
      const run = async (imports: unknown) =>
        h.executor.executeApproved({
          workspaceId: h.workspaceId, sessionId, runId, tool: 'attachment_import',
          args: { tool: 'attachment_import', imports } as never,
          argsJson: serializeToolArgs({ imports }), approvalId: null, now: 10
        })
      const unknown = await run([{ attachmentId: '0'.repeat(32), proposedRelativePath: 'public/x.png' }])
      assert.equal(unknown.status, 'failed')
      const unsafe = await run([{ attachmentId, proposedRelativePath: '../evil.png' }])
      assert.equal(unsafe.status, 'failed')
      assert.ok((unsafe.reason ?? '').length > 0)
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('ask parks with resolved names, approve creates once, workspace still unchanged', async () => {
    const h = openHarness()
    try {
      const { sessionId, attachmentId } = await seed(h)
      askImport(h)
      useVisionWorker(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'attachment_import', args: { imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'attachment_import')
      assert.equal(waiting.approval.capability, 'attachment.import')
      assert.ok(waiting.approval.summary.includes('hero.png'), 'approval must list the attachment name')
      assert.ok(waiting.approval.summary.includes('public/hero.png'), 'approval must list the destination')
      assert.ok(waiting.approval.summary.includes('does not modify'), 'approval must carry non-apply copy')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 0)
      const resumed = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(resumed.kind, 'completed')
      assert.equal(h.txRows.listRecentForWorkspace(h.workspaceId, 20).length, 1)
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')), 'approval creates a proposal only')
      await assert.rejects(h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id }))
    } finally {
      closeHarness(h)
    }
  })

  it('groups a same-run binary import with a text proposal into one set', async () => {
    const h = openHarness()
    try {
      const { sessionId, attachmentId } = await seed(h)
      allowProposeAskImport(h)
      useVisionWorker(h)
      h.adapter.planScript = [delegatePlan()]
      h.adapter.turnScript = [
        { kind: 'tool_request', tool: 'workspace_read', args: { relativePath: 'a.ts' } },
        { kind: 'tool_request', tool: 'change_propose', args: { changes: [{ targetRef: 'R1', summary: 'bump a', proposedContent: 'const a = 2\n' }] } },
        { kind: 'tool_request', tool: 'attachment_import', args: { imports: [{ attachmentId, proposedRelativePath: 'public/hero.png' }] } },
        { kind: 'final_text', text: 'DONE' }
      ]
      h.adapter.textScript = ['FINAL']
      // The text proposal executes immediately (allow); the import
      // parks for approval (ask-only) — then approval groups both.
      const waiting = await h.runner.runToolWork({ workspaceId: h.workspaceId, sessionId })
      assert.equal(waiting.kind, 'waiting_for_approval')
      if (waiting.kind !== 'waiting_for_approval') throw new Error('unreachable')
      assert.equal(waiting.approval.toolName, 'attachment_import')
      assert.ok(waiting.approval.summary.includes('public/hero.png'))
      const outcome = await h.runner.approveAndResume({ workspaceId: h.workspaceId, sessionId, approvalId: waiting.approval.id })
      assert.equal(outcome.kind, 'completed')
      if (outcome.kind !== 'completed') throw new Error('unreachable')
      const events = h.tools.listEvents(outcome.result.run.id)
      const grouped = events.find((event) => event.toolName === 'attachment_import' && event.status === 'succeeded')
      assert.ok(grouped !== undefined)
      const payload = JSON.parse(grouped.payload) as { kind: string; changeSetId?: number }
      assert.equal(payload.kind, 'change_set')
      const set = await h.changeSets.getChangeSet({ changeSetId: payload.changeSetId ?? 0 })
      assert.equal(set.items.length, 2)
      const kinds = set.items.map((item) => (item.transaction.files[0]?.binaryImport !== undefined ? 'binary' : 'text').toString())
      assert.ok(kinds.includes('binary') && kinds.includes('text'))
      assert.ok(!existsSync(join(h.root, 'public', 'hero.png')), 'grouping never writes')
      assert.equal(readFileSync(join(h.root, 'a.ts'), 'utf8'), 'const a = 1\n')
    } finally {
      closeHarness(h)
    }
  })

  it('Brain stays tool-free of attachment_import', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const brain = readFileSync(joinPath(process.cwd(), 'src', 'main', 'ai', 'ai-brain-service.ts'), 'utf8')
    assert.ok(!brain.includes('attachment_import'), 'Brain must not name the import tool')
  })
})
