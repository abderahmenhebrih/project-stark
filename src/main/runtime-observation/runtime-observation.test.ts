import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { CodingSessionService } from '../sessions/coding-session-service'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityService } from '../capabilities/capability-service'
import { CapabilityGate } from '../capabilities/capability-gate'
import { WorkerToolRepository, serializeToolArgs } from '../worker-tools/worker-tool-repository'
import { WorkerReadToolService, parseWorkerToolRequest } from '../worker-tools/worker-tool-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import { RuntimeObservationService, buildRuntimeObservationPayload } from './runtime-observation-service'
import {
  WORKER_RUNTIME_OBSERVE_DENY_MESSAGE,
  buildRuntimeObserveApprovalSummary,
  parseRuntimeObserveApprovalArgs,
  parseRuntimeObserveArgs
} from './runtime-observation-validation'
import { MAX_WORKER_RUNTIME_OBSERVATION_BYTES } from '../worker-tools/worker-tool-limits'
import { MAX_RUNTIME_SESSION_MS } from '../project-runtime/project-runtime-limits'

function openHarness(): {
  db: DatabaseSync
  dir: string
  workspaceId: number
  sessionId: number
  runId: number
  gate: CapabilityGate
  tools: WorkerToolRepository
  runtimes: ProjectRuntimeRepository
  observation: RuntimeObservationService
  executor: WorkerReadToolService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-runtime-observe-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const capStore = new CapabilityRepository(db)
  const capService = new CapabilityService(capStore, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const tools = new WorkerToolRepository(db)
  const runtimes = new ProjectRuntimeRepository(db)
  const observation = new RuntimeObservationService({ runtimes })
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const executor = new WorkerReadToolService({ gate, files, search, git, tools, runtimeObservation: observation })
  void capService
  return { db, dir, workspaceId, sessionId: 0, runId: 0, gate, tools, runtimes, observation, executor }
}

async function seedSession(h: ReturnType<typeof openHarness>): Promise<{ sessionId: number; runId: number }> {
  const workspaces = new WorkspaceRepository(h.db)
  const codingRows = new CodingSessionRepository(h.db)
  const sessions = new CodingSessionService(workspaces, codingRows)
  const session = await sessions.createSession({ workspaceId: h.workspaceId })
  await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Observe it.' })
  const messageId = codingRows.listMessagesNewestFirst(session.id, 1, null)[0]?.id ?? 1
  const runId = Number(
    h.db
      .prepare(
        "INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (?, ?, ?, 'running', 1, 1)"
      )
      .run(h.workspaceId, session.id, messageId).lastInsertRowid
  )
  return { sessionId: session.id, runId }
}

function allowObserve(h: ReturnType<typeof openHarness>): void {
  const workspaces = new WorkspaceRepository(h.db)
  const store = new CapabilityRepository(h.db)
  const service = new CapabilityService(store, workspaces)
  service.updateConfig({
    workspaceId: h.workspaceId,
    enabled: true,
    policies: [
      { capability: 'workspace.read', mode: 'deny' },
      { capability: 'workspace.search', mode: 'deny' },
      { capability: 'git.read', mode: 'deny' },
      { capability: 'change.propose', mode: 'deny' },
      { capability: 'terminal.execute', mode: 'deny' },
      { capability: 'runtime.observe', mode: 'allow' },
      { capability: 'preview.inspect', mode: 'deny' }
    ]
  })
}

function seedRuntime(
  h: ReturnType<typeof openHarness>,
  sessionId: number,
  runId: number,
  overrides?: { status?: string; stdout?: string; stderr?: string; port?: number }
): number {
  const approval = h.db
    .prepare(
      'INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(h.workspaceId, sessionId, runId, 'runtime_start', 'terminal.execute', '{}', 'h', 's', 'consumed', 1)
  const approvalId = Number(approval.lastInsertRowid)
  const port = overrides?.port ?? 5173
  const row = h.db
    .prepare(
      'INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, preview_port, status, exit_code, signal, stdout_tail, stderr_tail, logs_truncated, total_output_bytes, stop_reason, created_at, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      h.workspaceId, sessionId, runId, approvalId, 'npm', '{"program":"npm","args":[]}', 'h', port,
      overrides?.status ?? 'running', null, null, overrides?.stdout ?? 'hello', overrides?.stderr ?? 'warn', 0, 10, null, 1, 2, null, 2
    )
  return Number(row.lastInsertRowid)
}

describe('runtime_observe request validation', () => {
  it('accepts exactly the empty object', () => {
    assert.deepEqual(parseWorkerToolRequest('runtime_observe', {}), { tool: 'runtime_observe' })
    assert.deepEqual(parseRuntimeObserveArgs({}), {})
  })

  it('rejects runtimeId/log-limit/PID/path authority', () => {
    for (const args of [
      { runtimeId: 1 },
      { workspaceId: 1 },
      { sessionId: 1 },
      { limit: 10 },
      { offset: 0 },
      { pid: 123 },
      { path: 'x' }
    ]) {
      assert.throws(() => parseWorkerToolRequest('runtime_observe', args))
    }
  })

  it('binds exact runtime approval args', () => {
    assert.deepEqual(parseRuntimeObserveApprovalArgs({ runtimeId: 42 }), { runtimeId: 42 })
    assert.throws(() => parseRuntimeObserveApprovalArgs({}))
    assert.throws(() => parseRuntimeObserveApprovalArgs({ runtimeId: '42' }))
  })

  it('builds inert approval summaries with preview copy', () => {
    const summary = buildRuntimeObserveApprovalSummary({ program: 'npm', args: ['run', 'dev'], port: 5173 })
    assert.ok(summary.includes('Observe managed runtime'))
    assert.ok(summary.includes('npm'))
    assert.ok(summary.includes('http://127.0.0.1:5173/'))
    assert.ok(summary.includes('once'))
    assert.ok(summary.includes('does not allow'))
  })
})

describe('runtime observation service', () => {
  it('returns no_active_runtime when none exists', () => {
    const h = openHarness()
    try {
      const outcome = h.observation.observe(h.workspaceId)
      assert.equal(outcome.status, 'no_active_runtime')
      assert.deepEqual(JSON.parse(outcome.payloadJson), { status: 'no_active_runtime' })
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('observes starting and running runtimes with bounded shape', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      for (const status of ['starting', 'running']) {
        h.db.exec('DELETE FROM project_runtime_sessions')
        const id = seedRuntime(h, sessionId, runId, { status, stdout: 'out', stderr: 'err' })
        const outcome = h.observation.observe(h.workspaceId)
        assert.equal(outcome.status, 'observed')
        const payload = JSON.parse(outcome.payloadJson) as {
          status: string
          runtime: Record<string, unknown>
          logs: Record<string, unknown>
        }
        assert.equal(payload.status, 'observed')
        assert.equal(payload.runtime['runtimeId'], id)
        assert.equal(payload.runtime['state'], status)
        assert.equal(payload.runtime['program'], 'npm')
        assert.ok(Array.isArray(payload.runtime['args']))
        assert.equal(payload.runtime['previewUrl'], 'http://127.0.0.1:5173/')
        assert.equal(payload.runtime['previewPort'], 5173)
        assert.equal(payload.runtime['maximumLifetimeMs'], MAX_RUNTIME_SESSION_MS)
        assert.equal(payload.logs['stdout'], 'out')
        assert.equal(payload.logs['stderr'], 'err')
        assert.equal(typeof payload.logs['totalOutputBytes'], 'number')
        assert.equal(typeof payload.logs['olderOutputOmitted'], 'boolean')
        const text = JSON.stringify(payload)
        assert.ok(!text.includes('pid') || text.includes('rapid') === false)
      }
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('exposes no PID/paths/env/credentials', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'x'.repeat(100) })
      const payload = h.observation.observe(h.workspaceId).payloadJson
      const lower = payload.toLowerCase()
      assert.ok(!lower.includes('pid'))
      assert.ok(!lower.includes('env'))
      assert.ok(!lower.includes('credential'))
      assert.ok(!lower.includes('token'))
      const parsed = JSON.parse(payload) as { runtime: Record<string, unknown> }
      assert.deepEqual(Object.keys(parsed.runtime).sort(), ['args', 'maximumLifetimeMs', 'previewPort', 'previewUrl', 'program', 'runtimeId', 'startedAt', 'state'].sort())
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('caps the Worker observation at 64 KiB preferring newest logs', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'A'.repeat(100 * 1024), stderr: 'B'.repeat(100 * 1024) })
      const outcome = h.observation.observe(h.workspaceId)
      const bytes = Buffer.byteLength(outcome.payloadJson, 'utf8')
      assert.ok(bytes <= MAX_WORKER_RUNTIME_OBSERVATION_BYTES, `got ${bytes}`)
      const payload = JSON.parse(outcome.payloadJson) as { logs: { stdout: string; stderr: string; olderOutputOmitted: boolean } }
      assert.equal(payload.logs.olderOutputOmitted, true)
      // Newest retained: tails end with the newest chars.
      assert.ok(payload.logs.stdout.endsWith('A'))
      assert.ok(payload.logs.stderr.endsWith('B'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('observeBound rejects a replaced runtime (no retargeting)', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      const first = seedRuntime(h, sessionId, runId, { stdout: 'one' })
      assert.ok(h.observation.observeBound(h.workspaceId, first) !== null)
      h.db.exec(`UPDATE project_runtime_sessions SET status = 'stopped' WHERE id = ${first}`)
      const second = seedRuntime(h, sessionId, runId, { stdout: 'two' })
      assert.equal(h.observation.observeBound(h.workspaceId, first), null)
      const current = h.observation.observeBound(h.workspaceId, second)
      assert.ok(current !== null)
      assert.ok(current.payloadJson.includes('two'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('does not mutate the canonical persisted tail', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      const id = seedRuntime(h, sessionId, runId, { stdout: 'A'.repeat(100 * 1024) })
      const before = h.runtimes.findById(id)?.stdoutTail ?? ''
      h.observation.observe(h.workspaceId)
      const after = h.runtimes.findById(id)?.stdoutTail ?? ''
      assert.equal(before, after)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('observation service performs no runtime mutation (static)', () => {
    const source = readFileSync('src/main/runtime-observation/runtime-observation-service.ts', 'utf8')
    for (const forbidden of ['spawn(', 'kill(', 'stopRuntime', 'writeTextFile', 'acceptTransaction', 'terminal.write', 'generateText', 'generateStructured', 'SIGKILL', 'process.kill']) {
      assert.ok(!source.includes(forbidden), `observation service must not contain ${forbidden}`)
    }
  })
})

describe('runtime_observe capability flow', () => {
  it('deny persists a denied event with safe copy and no provider calls', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, {})
      const before = h.tools.listEvents(runId).length
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: Date.now()
      })
      assert.equal(result.status, 'denied')
      assert.equal(result.reason, WORKER_RUNTIME_OBSERVE_DENY_MESSAGE)
      assert.equal(h.tools.listEvents(runId).length, before + 1)
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('allow observes immediately with zero provider calls', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'live-log' })
      allowObserve(h)
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: Date.now()
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(result.payload.includes('live-log'))
    } finally {
      h.db.close()
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('builds bounded payloads via the pure builder', () => {
    const row = {
      id: 7, workspaceId: 1, sourceSessionId: 1, runId: 1, approvalId: 1, program: 'npm',
      argsJson: '{"program":"npm","args":["run"]}', argsHash: 'h', previewPort: 3000, status: 'running' as const,
      exitCode: null, signal: null, stdoutTail: 'o', stderrTail: 'e', logsTruncated: false,
      totalOutputBytes: 2, stopReason: null, createdAt: 1, startedAt: 2, endedAt: null, updatedAt: 2
    }
    const { payloadJson } = buildRuntimeObservationPayload(row)
    const payload = JSON.parse(payloadJson) as { runtime: { previewUrl: string } }
    assert.equal(payload.runtime.previewUrl, 'http://127.0.0.1:3000/')
  })
})
