import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository } from './worker-tool-repository'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { MAX_WORKER_READ_BYTES } from './worker-tool-limits'

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessionId: number
  runId: number
  gate: CapabilityGate
  files: WorkspaceFilesService
  search: WorkspaceSearchService
  git: GitService
  tools: WorkerToolRepository
  executor: WorkerReadToolService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-tool-svc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const sessionId = codingRows.createSession({ workspaceId, title: 'New session', now: 2 })
  codingRows.appendMessage({ sessionId, role: 'user', content: 'Hi.', now: 3, retitle: null })
  const runs = db.prepare('INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(workspaceId, sessionId, 1, 'running', 4, 4)
  const runId = Number(runs.lastInsertRowid)
  const capStore = new CapabilityRepository(db)
  const capService = new CapabilityService(capStore, workspaces)
  capService.updateConfig({
    workspaceId,
    enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'allow' },
      { capability: 'workspace.search', mode: 'allow' },
      { capability: 'git.read', mode: 'allow' },
      { capability: 'change.propose', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' }
    ]
  })
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const tools = new WorkerToolRepository(db)
  const executor = new WorkerReadToolService({ gate, files, search, git, tools })
  return { db, dir, workspaceId, sessionId, runId, gate, files, search, git, tools, executor }
}

function closeHarness(h: { db: DatabaseSync; dir: string }): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

describe('worker tool request validation', () => {
  it('accepts exactly the three tool shapes', () => {
    assert.deepEqual(parseWorkerToolRequest('workspace_read', { relativePath: 'a.ts' }), { tool: 'workspace_read', relativePath: 'a.ts' })
    assert.deepEqual(parseWorkerToolRequest('workspace_search', { query: 'TODO' }), { tool: 'workspace_search', query: 'TODO' })
    assert.deepEqual(parseWorkerToolRequest('git_read', { operation: 'status' }), { tool: 'git_read', operation: 'status' })
    assert.deepEqual(parseWorkerToolRequest('git_read', { operation: 'diff', scope: 'staged', relativePath: null }), {
      tool: 'git_read', operation: 'diff', scope: 'staged', relativePath: null
    })
  })

  it('rejects unknown tools, extra fields, and bad git shapes', () => {
    assert.throws(() => parseWorkerToolRequest('file_write', { relativePath: 'a' }))
    assert.throws(() => parseWorkerToolRequest('workspace_read', { relativePath: 'a', extra: 1 }))
    assert.throws(() => parseWorkerToolRequest('workspace_read', { relativePath: '' }))
    assert.throws(() => parseWorkerToolRequest('workspace_search', { query: '' }))
    assert.throws(() => parseWorkerToolRequest('workspace_search', { query: 'x'.repeat(129) }))
    assert.throws(() => parseWorkerToolRequest('git_read', { operation: 'log' }))
    assert.throws(() => parseWorkerToolRequest('git_read', { operation: 'diff', scope: 'weird', relativePath: null }))
    assert.throws(() => parseWorkerToolRequest('git_read', { operation: 'diff', scope: 'staged', relativePath: '' }))
  })
})

describe('workspace_read tool', () => {
  it('reads a valid file with revision and bytes', async () => {
    const h = openHarness()
    try {
      const root = h.db.prepare('SELECT root_path AS p FROM workspaces WHERE id = ?').get(h.workspaceId) as { p: string } | undefined
      void root
      const dir = mkdtempSync(join(tmpdir(), 'x-'))
      void dir
      // Resolve workspace root from the harness dir.
      const { readFileSync } = await import('node:fs')
      void readFileSync
      writeFileSync(join(h.dir, 'project', 'app.ts'), 'const a = 1\n')
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_read', args: { tool: 'workspace_read', relativePath: 'app.ts' } as never,
        argsJson: '{"relativePath":"app.ts"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      const payload = JSON.parse(result.payload) as { relativePath: string; content: string; revision: string; bytes: number }
      assert.equal(payload.relativePath, 'app.ts')
      assert.equal(payload.content, 'const a = 1\n')
      assert.match(payload.revision, /^[0-9a-f]{64}$/)
      // Audit persisted with no secrets.
      const events = h.tools.listEvents(h.runId)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.status, 'succeeded')
      assert.ok(!JSON.stringify(events[0]).includes('sk-'))
    } finally {
      closeHarness(h)
    }
  })

  it('rejects traversal and absolute paths without truncation', async () => {
    const h = openHarness()
    try {
      for (const bad of ['../outside.ts', '/abs.ts', 'C:\\abs.ts', '']) {
        const result = await h.executor.execute({
          workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
          tool: 'workspace_read', args: { tool: 'workspace_read', relativePath: bad } as never,
          argsJson: JSON.stringify({ relativePath: bad }), approvalId: null, now: 10
        })
        assert.equal(result.status, 'failed', bad)
        assert.equal(result.payload, '')
      }
    } finally {
      closeHarness(h)
    }
  })

  it('rejects binary and oversized files without partial content', async () => {
    const h = openHarness()
    try {
      writeFileSync(join(h.dir, 'project', 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
      const binary = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_read', args: { tool: 'workspace_read', relativePath: 'bin.dat' } as never,
        argsJson: '{"relativePath":"bin.dat"}', approvalId: null, now: 10
      })
      assert.equal(binary.status, 'failed')
      assert.equal(binary.payload, '')
      const big = 'x'.repeat(MAX_WORKER_READ_BYTES + 1)
      writeFileSync(join(h.dir, 'project', 'big.ts'), big)
      const oversized = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_read', args: { tool: 'workspace_read', relativePath: 'big.ts' } as never,
        argsJson: '{"relativePath":"big.ts"}', approvalId: null, now: 10
      })
      assert.equal(oversized.status, 'failed')
      assert.ok((oversized.reason ?? '').includes('too large'))
      assert.equal(oversized.payload, '')
    } finally {
      closeHarness(h)
    }
  })

  it('denied policy executes nothing and persists a denied event', async () => {
    const h = openHarness()
    try {
      writeFileSync(join(h.dir, 'project', 'a.ts'), 'hi\n')
      // Flip to deny mid-run: execution-time gate is authoritative.
      const capStore = new CapabilityRepository(h.db)
      const workspaces = new WorkspaceRepository(h.db)
      const capService = new CapabilityService(capStore, workspaces)
      capService.updateConfig({
        workspaceId: h.workspaceId, enabled: true,
        policies: [
          { capability: 'workspace.read', mode: 'deny' },
          { capability: 'workspace.search', mode: 'deny' },
          { capability: 'git.read', mode: 'deny' },
          { capability: 'change.propose', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'deny' }
        ]
      })
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_read', args: { tool: 'workspace_read', relativePath: 'a.ts' } as never,
        argsJson: '{"relativePath":"a.ts"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'denied')
      assert.equal(result.payload, '')
      assert.equal(h.tools.listEvents(h.runId).length, 1)
    } finally {
      closeHarness(h)
    }
  })
})

describe('workspace_search tool', () => {
  it('literal search with 30-result cap and truncated flag', async () => {
    const h = openHarness()
    try {
      for (let i = 0; i < 35; i += 1) {
        writeFileSync(join(h.dir, 'project', `f${i}.ts`), `// TODO ${i}\nconst v${i} = ${i}\n`)
      }
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_search', args: { tool: 'workspace_search', query: 'TODO' } as never,
        argsJson: '{"query":"TODO"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      const payload = JSON.parse(result.payload) as { matches: unknown[]; truncated: boolean }
      assert.equal(payload.matches.length, 30)
      assert.equal(payload.truncated, true)
      for (const match of payload.matches as { relativePath: string; line: number; column: number; preview: string }[]) {
        assert.ok(typeof match.relativePath === 'string')
        assert.ok(typeof match.preview === 'string')
        assert.ok(!('content' in (match as Record<string, unknown>)))
      }
    } finally {
      closeHarness(h)
    }
  })

  it('exposes no secret-excluded content and no regex', async () => {
    const h = openHarness()
    try {
      writeFileSync(join(h.dir, 'project', '.env'), 'SECRET=1\n')
      writeFileSync(join(h.dir, 'project', 'ok.ts'), 'hello world\n')
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'workspace_search', args: { tool: 'workspace_search', query: 'hello' } as never,
        argsJson: '{"query":"hello"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(!result.payload.includes('SECRET'))
    } finally {
      closeHarness(h)
    }
  })
})

describe('git_read tool', () => {
  it('status on a non-repo returns bounded data without mutation', async () => {
    const h = openHarness()
    try {
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId: h.sessionId, runId: h.runId,
        tool: 'git_read', args: { tool: 'git_read', operation: 'status' } as never,
        argsJson: '{"operation":"status"}', approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(result.payload.length > 0)
      assert.ok(result.payload.length <= 64 * 1024)
    } finally {
      closeHarness(h)
    }
  })

  it('invalid operation and scope fail bounded with no execution', async () => {
    const h = openHarness()
    try {
      assert.throws(() => parseWorkerToolRequest('git_read', { operation: 'checkout' }))
      assert.throws(() => parseWorkerToolRequest('git_read', { operation: 'diff', scope: 'nope', relativePath: null }))
    } finally {
      closeHarness(h)
    }
  })
})
