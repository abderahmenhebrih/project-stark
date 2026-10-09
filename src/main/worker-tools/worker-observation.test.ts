import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
import { AGENT_CAPABILITIES } from '../capabilities/capability-registry'
import { WorkerToolRepository, hashToolArgs, serializeToolArgs } from './worker-tool-repository'
import { WorkerReadToolService, parseWorkerToolRequest } from './worker-tool-service'
import { capabilityForTool, workerToolSchemas, WORKER_TOOLS } from './worker-tool-registry'
import {
  MAX_WORKER_TOOL_CALLS,
  MAX_WORKER_TURNS,
  MAX_TOOL_WORK_PROVIDER_CALLS,
  MAX_WORKER_RUNTIME_OBSERVATION_BYTES,
  MAX_PREVIEW_INSPECTION_RESULT_BYTES
} from './worker-tool-limits'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { GitService } from '../git/git-service'
import { GitProcessRunner } from '../git/git-process-runner'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import { RuntimeObservationService } from '../runtime-observation/runtime-observation-service'
import { PreviewInspectionService, type RawPreviewSnapshot } from '../preview-inspection/preview-inspection-service'
import { IPC_CHANNELS } from '../../shared/constants'

function readMain(relative: string): string {
  return readFileSync(join(process.cwd(), 'src', 'main', relative), 'utf8')
}

interface Harness {
  db: DatabaseSync
  dir: string
  workspaceId: number
  capService: CapabilityService
  gate: CapabilityGate
  tools: WorkerToolRepository
  runtimes: ProjectRuntimeRepository
  observation: RuntimeObservationService
  inspection: PreviewInspectionService
  executor: WorkerReadToolService
}

function openHarness(inspectionOverrides?: {
  visibleUrl?: string | null
  snapshot?: RawPreviewSnapshot
  loads?: { count: number }
  destroyed?: { count: number }
}): Harness {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-worker-obs-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'app.ts'), 'export const x = 1\n')
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const capStore = new CapabilityRepository(db)
  const capService = new CapabilityService(capStore, workspaces)
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const tools = new WorkerToolRepository(db)
  const runtimes = new ProjectRuntimeRepository(db)
  const observation = new RuntimeObservationService({ runtimes })
  const loads = inspectionOverrides?.loads ?? { count: 0 }
  const destroyed = inspectionOverrides?.destroyed ?? { count: 0 }
  const inspection = new PreviewInspectionService({
    runtimes,
    getVisiblePreviewUrl:
      inspectionOverrides?.visibleUrl === undefined ? () => null : () => (inspectionOverrides.visibleUrl ?? null),
    createHiddenInspector: () => ({
      loadURL: async () => {
        loads.count += 1
      },
      collectSnapshot: async () =>
        inspectionOverrides?.snapshot ?? {
          title: 'T',
          readyState: 'complete',
          url: 'http://127.0.0.1:5173/',
          visibleText: 'hello',
          elements: []
        },
      destroy: () => {
        destroyed.count += 1
      },
      isDestroyed: () => false
    })
  })
  const files = new WorkspaceFilesService(workspaces)
  const search = new WorkspaceSearchService(workspaces)
  const git = new GitService(workspaces, new GitProcessRunner())
  const executor = new WorkerReadToolService({
    gate, files, search, git, tools, runtimeObservation: observation, previewInspection: inspection
  })
  return { db, dir, workspaceId, capService, gate, tools, runtimes, observation, inspection, executor }
}

function closeHarness(h: Harness): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

async function seedSession(h: Harness): Promise<{ sessionId: number; runId: number }> {
  const workspaces = new WorkspaceRepository(h.db)
  const codingRows = new CodingSessionRepository(h.db)
  const sessions = new CodingSessionService(workspaces, codingRows)
  const session = await sessions.createSession({ workspaceId: h.workspaceId })
  await sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId: session.id, content: 'Diagnose it.' })
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

function setPolicies(h: Harness, modes: Record<string, string>): void {
  h.capService.updateConfig({
    workspaceId: h.workspaceId,
    enabled: true,
    policies: AGENT_CAPABILITIES.map((capability) => ({
      capability,
      mode: (modes[capability] ?? 'deny') as 'deny' | 'ask' | 'allow'
    }))
  })
}

function insertApproval(h: Harness, sessionId: number, runId: number, toolName: string, capability: string, argsJson: string): number {
  const argsHash = hashToolArgs(argsJson)
  const row = h.db
    .prepare(
      'INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(h.workspaceId, sessionId, runId, toolName, capability, argsJson, argsHash, 'test approval', 'pending', 5)
  return Number(row.lastInsertRowid)
}

function seedRuntime(h: Harness, sessionId: number, runId: number, overrides?: { stdout?: string; port?: number }): number {
  const approval = h.db
    .prepare(
      'INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(h.workspaceId, sessionId, runId, 'runtime_start', 'terminal.execute', '{}', 'h', 's', 'consumed', 1)
  const approvalId = Number(approval.lastInsertRowid)
  const row = h.db
    .prepare(
      'INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, preview_port, status, exit_code, signal, stdout_tail, stderr_tail, logs_truncated, total_output_bytes, stop_reason, created_at, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      h.workspaceId, sessionId, runId, approvalId, 'npm', '{"program":"npm","args":[]}', 'h',
      overrides?.port ?? 5173, 'running', null, null, overrides?.stdout ?? 'log-line', 'err', 0, 8, null, 1, 2, null, 2
    )
  return Number(row.lastInsertRowid)
}

describe('stage 27 tool registry', () => {
  it('contains exactly eight Worker tools', () => {
    assert.deepEqual(
      [...WORKER_TOOLS].sort(),
      ['change_propose', 'git_read', 'preview_inspect', 'runtime_observe', 'runtime_start', 'terminal_execute', 'workspace_read', 'workspace_search'].sort()
    )
    assert.equal(workerToolSchemas().length, 8)
    assert.ok(!WORKER_TOOLS.includes('browser_click' as never))
    assert.ok(!WORKER_TOOLS.includes('browser_type' as never))
    assert.ok(!WORKER_TOOLS.includes('browser_navigate' as never))
    assert.ok(!WORKER_TOOLS.includes('runtime_stop' as never))
    assert.ok(!WORKER_TOOLS.includes('fetch' as never))
    assert.ok(!WORKER_TOOLS.includes('javascript' as never))
  })

  it('maps observations to the new capabilities', () => {
    assert.equal(capabilityForTool('runtime_observe'), 'runtime.observe')
    assert.equal(capabilityForTool('preview_inspect'), 'preview.inspect')
  })

  it('observation schemas are exactly empty objects', () => {
    for (const name of ['runtime_observe', 'preview_inspect'] as const) {
      const schema = workerToolSchemas().find((entry) => entry.name === name)
      assert.ok(schema !== undefined)
      const parameters = schema.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
      assert.deepEqual(parameters.required, [])
      assert.deepEqual(parameters.properties, {})
      assert.equal(parameters.additionalProperties, false)
    }
  })

  it('provider request shapes carry no authority (untrusted DATA)', () => {
    assert.deepEqual(parseWorkerToolRequest('runtime_observe', {}), { tool: 'runtime_observe' })
    assert.deepEqual(parseWorkerToolRequest('preview_inspect', {}), { tool: 'preview_inspect' })
    for (const extra of [{ runtimeId: 1 }, { url: 'http://x/' }, { path: '/' }, { selector: 'a' }, { script: 'x' }]) {
      assert.throws(() => parseWorkerToolRequest('runtime_observe', extra))
      assert.throws(() => parseWorkerToolRequest('preview_inspect', extra))
    }
  })
})

describe('stage 27 capability expansion', () => {
  it('registry contains exactly seven capabilities', () => {
    assert.deepEqual([...AGENT_CAPABILITIES], [
      'workspace.read', 'workspace.search', 'git.read', 'change.propose', 'terminal.execute', 'runtime.observe', 'preview.inspect'
    ])
  })

  it('new capabilities default to deny and old five-row updates reject', async () => {
    const h = openHarness()
    try {
      const { sessionId } = await seedSession(h)
      void sessionId
      const config = h.capService.getConfig({ workspaceId: h.workspaceId })
      assert.equal(config.policies.length, 7)
      assert.ok(config.policies.every((entry) => entry.mode === 'deny'))
      assert.throws(() =>
        h.capService.updateConfig({
          workspaceId: h.workspaceId,
          enabled: true,
          policies: [
            { capability: 'workspace.read', mode: 'allow' },
            { capability: 'workspace.search', mode: 'allow' },
            { capability: 'git.read', mode: 'allow' },
            { capability: 'change.propose', mode: 'allow' },
            { capability: 'terminal.execute', mode: 'deny' }
          ] as never
        })
      )
    } finally {
      closeHarness(h)
    }
  })

  it('ask/allow advertise, deny hides, master disable denies all', async () => {
    const h = openHarness()
    try {
      const { sessionId } = await seedSession(h)
      setPolicies(h, { 'runtime.observe': 'allow', 'preview.inspect': 'ask' })
      assert.equal(h.gate.authorize({ workspaceId: h.workspaceId, sessionId, actor: 'worker', capability: 'runtime.observe' }).decision, 'allow')
      assert.equal(h.gate.authorize({ workspaceId: h.workspaceId, sessionId, actor: 'worker', capability: 'preview.inspect' }).decision, 'requires_approval')
      setPolicies(h, {})
      assert.equal(h.gate.authorize({ workspaceId: h.workspaceId, sessionId, actor: 'worker', capability: 'runtime.observe' }).decision, 'deny')
      h.capService.updateConfig({
        workspaceId: h.workspaceId,
        enabled: false,
        policies: AGENT_CAPABILITIES.map((capability) => ({ capability, mode: 'allow' as const })).map((entry) =>
          entry.capability === 'terminal.execute' ? { ...entry, mode: 'ask' as const } : entry
        )
      })
      assert.equal(h.gate.authorize({ workspaceId: h.workspaceId, sessionId, actor: 'worker', capability: 'runtime.observe' }).decision, 'deny')
    } finally {
      closeHarness(h)
    }
  })
})

describe('runtime_observe execution gate', () => {
  it('deny persists a denied event and the Worker continues', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, {})
      setPolicies(h, {})
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(result.status, 'denied')
      const events = h.tools.listEvents(runId)
      assert.equal(events.length, 1)
      assert.equal(events[0]?.status, 'denied')
    } finally {
      closeHarness(h)
    }
  })

  it('allow observes the active runtime with bounded logs', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'server ready on 5173' })
      setPolicies(h, { 'runtime.observe': 'allow' })
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(result.payload.includes('server ready on 5173'))
      assert.ok(Buffer.byteLength(result.payload, 'utf8') <= MAX_WORKER_RUNTIME_OBSERVATION_BYTES)
    } finally {
      closeHarness(h)
    }
  })

  it('exact approval binding rejects a replaced runtime', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      const first = seedRuntime(h, sessionId, runId, { stdout: 'first' })
      setPolicies(h, { 'runtime.observe': 'ask' })
      const argsJson = serializeToolArgs({ runtimeId: first })
      const approvalId = insertApproval(h, sessionId, runId, 'runtime_observe', 'runtime.observe', argsJson)
      h.db.exec(`UPDATE project_runtime_sessions SET status = 'stopped' WHERE id = ${first}`)
      const second = seedRuntime(h, sessionId, runId, { stdout: 'second' })
      void second
      const result = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: {} as never,
        argsJson, approvalId, now: 20
      })
      assert.equal(result.status, 'failed')
      assert.ok((result.reason ?? '').length > 0)
    } finally {
      closeHarness(h)
    }
  })

  it('policy revoke between advertisement and execution denies', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      const id = seedRuntime(h, sessionId, runId, {})
      setPolicies(h, { 'runtime.observe': 'ask' })
      const argsJson = serializeToolArgs({ runtimeId: id })
      const approvalId = insertApproval(h, sessionId, runId, 'runtime_observe', 'runtime.observe', argsJson)
      setPolicies(h, {})
      const result = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: {} as never,
        argsJson, approvalId, now: 20
      })
      assert.equal(result.status, 'denied')
    } finally {
      closeHarness(h)
    }
  })

  it('hash tamper never observes (approval args verification)', () => {
    const canonical = serializeToolArgs({ runtimeId: 5 })
    const tampered = serializeToolArgs({ runtimeId: 6 })
    assert.notEqual(hashToolArgs(canonical), hashToolArgs(tampered))
  })
})

describe('preview_inspect execution gate', () => {
  it('deny performs no inspection and no window load', async () => {
    const loads = { count: 0 }
    const h = openHarness({ loads })
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, {})
      setPolicies(h, {})
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'preview_inspect', args: { tool: 'preview_inspect' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(result.status, 'denied')
      assert.equal(loads.count, 0)
    } finally {
      closeHarness(h)
    }
  })

  it('allow inspects the hidden root with exactly one load and cleanup', async () => {
    const loads = { count: 0 }
    const destroyed = { count: 0 }
    const h = openHarness({ loads, destroyed, visibleUrl: null })
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, {})
      setPolicies(h, { 'preview.inspect': 'allow' })
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'preview_inspect', args: { tool: 'preview_inspect' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      assert.equal(loads.count, 1)
      assert.equal(destroyed.count, 1)
      assert.ok(Buffer.byteLength(result.payload, 'utf8') <= MAX_PREVIEW_INSPECTION_RESULT_BYTES)
    } finally {
      closeHarness(h)
    }
  })

  it('frozen approval never takes a Worker URL and inspects the frozen path', async () => {
    const h = openHarness({ visibleUrl: 'http://127.0.0.1:5173/other' })
    try {
      const { sessionId, runId } = await seedSession(h)
      const id = seedRuntime(h, sessionId, runId, {})
      setPolicies(h, { 'preview.inspect': 'ask' })
      const argsJson = serializeToolArgs({ runtimeId: id, targetPathAndQueryAndHash: '/frozen' })
      const approvalId = insertApproval(h, sessionId, runId, 'preview_inspect', 'preview.inspect', argsJson)
      const result = await h.executor.executeApproved({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'preview_inspect', args: {} as never,
        argsJson, approvalId, now: 20
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(result.payload.includes('http://127.0.0.1:5173/frozen'))
    } finally {
      closeHarness(h)
    }
  })

  it('no form values, cookies, or storage enter the Worker result', async () => {
    const h = openHarness({
      snapshot: {
        title: 'Login',
        readyState: 'complete',
        url: 'http://127.0.0.1:5173/',
        visibleText: 'Sign in',
        elements: [
          { tag: 'input', role: null, type: 'password', name: 'pw', ariaLabel: 'Password', placeholder: 'Secret', text: '', href: null, value: 's3cret-value' } as never
        ]
      }
    })
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, {})
      setPolicies(h, { 'preview.inspect': 'allow' })
      const result = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'preview_inspect', args: { tool: 'preview_inspect' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(result.status, 'succeeded')
      assert.ok(!result.payload.includes('s3cret-value'))
      const lower = result.payload.toLowerCase()
      assert.ok(!lower.includes('cookie'))
      const parsed = JSON.parse(result.payload) as { elements: Record<string, unknown>[] }
      assert.ok(parsed.elements.every((entry) => !('value' in entry)))
    } finally {
      closeHarness(h)
    }
  })
})

describe('stage 27 bounds and isolation', () => {
  it('tool budget remains four and provider calls remain seven with zero for observations', () => {
    assert.equal(MAX_WORKER_TOOL_CALLS, 4)
    assert.equal(MAX_WORKER_TURNS, 5)
    assert.equal(MAX_TOOL_WORK_PROVIDER_CALLS, 7)
    const runnerSource = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runnerSource.includes('MAX_WORKER_TOOL_CALLS'))
    assert.ok(runnerSource.includes('MAX_WORKER_TURNS'))
  })

  it('observations create no proposal authority (readRef still required)', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'see src/app.ts with full source' })
      setPolicies(h, { 'runtime.observe': 'allow', 'preview.inspect': 'allow', 'change.propose': 'allow', 'workspace.read': 'allow' })
      const observed = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(observed.status, 'succeeded')
      // A log mentioning a file does NOT authorize change_propose: the
      // executor still requires same-run successful workspace_read refs.
      const proposed = await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'change_propose',
        args: { tool: 'change_propose', changes: [{ targetRef: 'R1', summary: 'x', proposedContent: 'y' }] } as never,
        argsJson: serializeToolArgs({ changes: [{ targetRef: 'R1', summary: 'x', proposedContent: 'y' }] }),
        approvalId: null, now: 11
      })
      assert.equal(proposed.status, 'failed')
    } finally {
      closeHarness(h)
    }
  })

  it('starting a runtime alone injects no logs or DOM into Worker state', async () => {
    const h = openHarness()
    try {
      const { sessionId, runId } = await seedSession(h)
      seedRuntime(h, sessionId, runId, { stdout: 'secret-log-line' })
      // No tool event exists until the Worker explicitly observes.
      assert.equal(h.tools.listEvents(runId).length, 0)
      setPolicies(h, { 'runtime.observe': 'allow' })
      await h.executor.execute({
        workspaceId: h.workspaceId, sessionId, runId, tool: 'runtime_observe', args: { tool: 'runtime_observe' },
        argsJson: serializeToolArgs({}), approvalId: null, now: 10
      })
      assert.equal(h.tools.listEvents(runId).length, 1)
    } finally {
      closeHarness(h)
    }
  })

  it('production IPC surface is unchanged (no observation channels)', () => {
    const channels = Object.values(IPC_CHANNELS)
    assert.ok(!channels.some((channel) => channel.includes('observe')))
    assert.ok(!channels.some((channel) => channel.includes('inspect')))
    assert.ok(!channels.some((channel) => channel.includes('browser')))
  })

  it('worker instruction documents explicit observation only', () => {
    const runner = readMain('worker-tools/worker-tool-runner.ts')
    assert.ok(runner.includes('runtime_observe'))
    assert.ok(runner.includes('preview_inspect'))
    assert.ok(runner.includes('untrusted data'))
    assert.ok(runner.includes('Use workspace_read before proposing changes'))
  })
})
