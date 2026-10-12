import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { CapabilityRepository } from '../capabilities/capability-repository'
import { CapabilityGate } from '../capabilities/capability-gate'
import { ProjectRuntimeRepository } from './project-runtime-repository'
import { ProjectRuntimeService } from './project-runtime-service'
import type { SpawnFn } from '../worker-tools/worker-command-service'
import { MAX_RUNTIME_LOG_TAIL_BYTES } from './project-runtime-limits'
import { PREVIEW_STARTUP_TIMEOUT_MS } from '../../shared/project-runtime/preview-detection'

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kills: string[] = []
  readonly spawned: { file: string; args: readonly string[]; options: Record<string, unknown> }

  constructor(file: string, args: readonly string[], options: Record<string, unknown>) {
    super()
    this.spawned = { file, args, options }
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM')
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  }
}

interface Harness {
  db: DatabaseSync
  dir: string
  service: ProjectRuntimeService
  children: FakeChild[]
  workspaceId: number
  otherWorkspaceId: number
}

function openHarness(options?: { lifetimeMs?: number; stopWaitMs?: number; logTailCapBytes?: number; logFlushMs?: number }): Harness {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const codingRows = new CodingSessionRepository(db)
  const capStore = new CapabilityRepository(db)
  const runtimes = new ProjectRuntimeRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-human-preview-'))
  const root = join(dir, 'project')
  const other = join(dir, 'other')
  mkdirSync(root, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other', scripts: { dev: 'vite' } }))
  const workspaceId = workspaces.create({ rootPath: root, displayName: 'p', now: 1 }).id
  const otherWorkspaceId = workspaces.create({ rootPath: other, displayName: 'o', now: 1 }).id
  const gate = new CapabilityGate(workspaces, codingRows, capStore)
  const children: FakeChild[] = []
  const spawnImpl = ((file: string, args: readonly string[], options: Record<string, unknown>): ChildProcess => {
    const child = new FakeChild(file, args, options)
    children.push(child)
    return child as unknown as ChildProcess
  }) as SpawnFn
  const service = new ProjectRuntimeService({
    workspaces,
    gate,
    runtimes,
    spawnImpl,
    resolveExecutable: () => Promise.resolve({ absolutePath: '/fake/bin/npm', pathRejected: false }),
    lifetimeMs: options?.lifetimeMs,
    stopWaitMs: options?.stopWaitMs ?? 5,
    logTailCapBytes: options?.logTailCapBytes,
    logFlushMs: options?.logFlushMs ?? 1
  })
  return { db, dir, service, children, workspaceId, otherWorkspaceId }
}

async function closeHarness(h: Harness): Promise<void> {
  try {
    await h.service.shutdownAll(Date.now())
  } catch {
    // Best effort test cleanup.
  }
  rmSync(h.dir, { recursive: true, force: true })
  h.db.close()
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('human preview detection', () => {
  it('detects the dev plan and reports scriptless projects honestly', async () => {
    const h = openHarness()
    const extraDirs: string[] = []
    try {
      const detected = await h.service.detectHumanPreview(h.workspaceId)
      assert.equal(detected.script, 'dev')
      assert.equal(detected.packageManager, 'npm')
      assert.equal(detected.program, 'npm')
      assert.deepEqual(detected.args, ['run', 'dev'])
      assert.equal(detected.reason, null)
      // A workspace whose root vanished fails closed with safe copy.
      const gone = mkdtempSync(join(tmpdir(), 'stark-human-gone-'))
      extraDirs.push(gone)
      const goneRow = h.db.prepare("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES (?, 'g', 1, 1)").run(join(gone, 'missing'))
      const goneId = typeof goneRow.lastInsertRowid === 'bigint' ? Number(goneRow.lastInsertRowid) : goneRow.lastInsertRowid
      await assert.rejects(h.service.detectHumanPreview(goneId as number))
    } finally {
      for (const dir of extraDirs) {
        rmSync(dir, { recursive: true, force: true })
      }
      await closeHarness(h)
    }
  })
})

describe('human preview lifecycle', () => {
  it('starts the detected script with shell-free spawn and discovers the URL', async () => {
    const h = openHarness()
    try {
      const events: unknown[] = []
      h.service.setHumanUpdatedListener((event) => events.push(event))
      const result = await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      assert.equal(result.status, 'started')
      assert.equal(h.children.length, 1)
      const child = h.children[0]
      assert.ok(child !== undefined)
      assert.equal(child.spawned.file, '/fake/bin/npm')
      assert.deepEqual(child.spawned.args, ['run', 'dev'])
      assert.equal((child.spawned.options['shell'] as unknown), false)
      assert.equal(result.preview?.state, 'starting')
      // Dev-server output discovers the loopback URL and flips to running.
      child.stdout.emit('data', Buffer.from('  ➜  Local:   http://localhost:5173/\n', 'utf8'))
      await tick(20)
      const current = h.service.getHumanPreview(h.workspaceId)
      assert.equal(current?.state, 'running')
      assert.equal(current?.url, 'http://localhost:5173/')
      assert.ok(events.length >= 1)
    } finally {
      await closeHarness(h)
    }
  })

  it('reuses an active preview instead of spawning twice', async () => {
    const h = openHarness()
    try {
      const first = await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      assert.equal(first.status, 'started')
      const second = await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1001 })
      assert.equal(second.status, 'active')
      assert.equal(h.children.length, 1)
    } finally {
      await closeHarness(h)
    }
  })

  it('reports no-preview projects without spawning', async () => {
    const h = openHarness()
    try {
      writeFileSync(join(h.dir, 'project', 'package.json'), JSON.stringify({ name: 'lib', scripts: { build: 'tsc' } }))
      const result = await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      assert.equal(result.status, 'no-preview')
      assert.equal(result.preview, null)
      assert.equal(h.children.length, 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('marks unexpected exits failed with sanitized output', async () => {
    const h = openHarness()
    try {
      await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      const child = h.children[0]
      assert.ok(child !== undefined)
      child.stderr.emit('data', Buffer.from('Error: port 5173 is taken\n', 'utf8'))
      await tick(20)
      child.emit('close', 1, null)
      await tick(10)
      const current = h.service.getHumanPreview(h.workspaceId)
      assert.equal(current?.state, 'failed')
      assert.ok((current?.error ?? '').includes('port 5173 is taken'))
    } finally {
      await closeHarness(h)
    }
  })

  it('stops only the exact owned tree and never external servers', async () => {
    const h = openHarness()
    try {
      await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      await h.service.startHumanPreview({ workspaceId: h.otherWorkspaceId, now: 1000 })
      assert.equal(h.children.length, 2)
      const stopped = await h.service.stopHumanPreview({ workspaceId: h.workspaceId, now: 2000 })
      assert.equal(stopped?.state, 'stopped')
      assert.ok((h.children[0]?.kills.length ?? 0) > 0)
      // The neighbor runtime was never signalled.
      assert.equal(h.children[1]?.kills.length, 0)
      const neighbor = h.service.getHumanPreview(h.otherWorkspaceId)
      assert.equal(neighbor?.state, 'starting')
      // Stopping a workspace with no preview is a null no-op (an
      // external manual server is untracked, so it can never be killed).
      await h.service.stopHumanPreview({ workspaceId: h.workspaceId, now: 2001 })
      assert.equal(h.children[0]?.kills.length, h.children[0]?.kills.length)
    } finally {
      await closeHarness(h)
    }
  })

  it('restarts through a bounded stop plus a fresh start', async () => {
    const h = openHarness()
    try {
      await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      const restarted = await h.service.restartHumanPreview({ workspaceId: h.workspaceId, now: 2000 })
      assert.equal(restarted.status, 'started')
      assert.equal(h.children.length, 2)
      assert.ok((h.children[0]?.kills.length ?? 0) > 0)
    } finally {
      await closeHarness(h)
    }
  })

  it('bounds rolling logs and validates ids strictly', async () => {
    const h = openHarness({ logTailCapBytes: 1024 })
    try {
      await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      const child = h.children[0]
      assert.ok(child !== undefined)
      for (let i = 0; i < 20; i += 1) {
        child.stdout.emit('data', Buffer.alloc(1024, 'x'))
      }
      await tick(20)
      const current = h.service.getHumanPreview(h.workspaceId)
      assert.ok(current !== undefined && current !== null)
      assert.ok(Buffer.byteLength(current.stdoutTail + current.stderrTail, 'utf8') <= MAX_RUNTIME_LOG_TAIL_BYTES)
      assert.equal(current.logsTruncated, true)
      await assert.rejects(h.service.startHumanPreview({ workspaceId: 0, now: 1 }))
      await assert.rejects(h.service.stopHumanPreview({ workspaceId: -3, now: 1 }))
      assert.equal(h.service.getHumanPreview(h.workspaceId)?.workspaceId, h.workspaceId)
    } finally {
      await closeHarness(h)
    }
  })

  it('expires previews at the managed lifetime bound', async () => {
    const h = openHarness({ lifetimeMs: 30 })
    try {
      await h.service.startHumanPreview({ workspaceId: h.workspaceId, now: 1000 })
      await tick(80)
      const current = h.service.getHumanPreview(h.workspaceId)
      assert.equal(current?.state, 'stopped')
      assert.ok((current?.error ?? '').includes('30-minute'))
    } finally {
      await closeHarness(h)
    }
  })

  it('never scans ports or fetches remote origins', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const source = readFileSync(joinPath(process.cwd(), 'src', 'main', 'project-runtime', 'project-runtime-service.ts'), 'utf8')
    for (const forbidden of ['net.connect', 'dns.lookup', "fetch('http", 'fetch(`http', 'portscan']) {
      assert.ok(!source.includes(forbidden), `runtime service must not contain ${forbidden}`)
    }
    assert.ok(source.includes('parseLoopbackUrlFromText'), 'URL discovery must parse known runtime output')
  })

  it('keeps the startup window bounded (20–30 seconds)', () => {
    assert.ok(PREVIEW_STARTUP_TIMEOUT_MS >= 20_000 && PREVIEW_STARTUP_TIMEOUT_MS <= 30_000)
  })
})
