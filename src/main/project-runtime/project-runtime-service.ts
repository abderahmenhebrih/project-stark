import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { TextEncoder } from 'node:util'
import type { CapabilityGate } from '../capabilities/capability-gate'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import type {
  ProjectRuntimeSummary,
  ProjectRuntimeUpdatedEvent
} from '../../shared/project-runtime/types'
import { previewUrlForPort } from '../../shared/project-runtime/types'
import { resolveWorkerExecutable } from '../worker-tools/worker-executable'
import { buildWorkerCommandEnv, normalizeCommandOutput } from '../worker-tools/worker-command-service'
import type { SpawnFn } from '../worker-tools/worker-command-service'
import { InvalidWorkerToolRequestError } from '../worker-tools/worker-tool-errors'
import { ProjectRuntimeRepository, type StoredRuntimeSession } from './project-runtime-repository'
import {
  MAX_RECENT_RUNTIMES,
  MAX_RUNTIME_LOG_TAIL_BYTES,
  MAX_RUNTIME_SESSION_MS,
  MAX_RUNTIME_SHUTDOWN_MS,
  MAX_RUNTIME_STOP_WAIT_MS,
  MIN_RUNTIME_LOG_FLUSH_MS
} from './project-runtime-limits'
import {
  WORKER_RUNTIME_DENY_MESSAGE,
  WORKER_RUNTIME_INVALID_POLICY_MESSAGE,
  parseRuntimeStartArgs
} from '../worker-tools/worker-runtime-validation'
import { killProcessTree } from './process-tree'
import { isAllowedPreviewNavigation, wirePreviewWindow, type PreviewWindow } from './runtime-preview'

const encoder = new TextEncoder()

/** Reads the inert argv array from a stored tool-args JSON blob. */
function parseStoredArgs(argsJson: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(argsJson) as unknown
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['args'])) {
      const args = (parsed as Record<string, unknown>)['args'] as unknown[]
      if (args.every((entry): entry is string => typeof entry === 'string')) {
        return [...args]
      }
    }
  } catch {
    // Stored rows are main-written; fall through to empty on any surprise.
  }
  return []
}

export type ApprovedRuntimeResult =
  | { readonly kind: 'started'; readonly runtimeId: number; readonly previewUrl: string; readonly port: number }
  | { readonly kind: 'active'; readonly runtime: ProjectRuntimeSummary }
  | { readonly kind: 'failed' }
  | { readonly kind: 'denied'; readonly reason: string }

interface LiveRuntime {
  child: ChildProcess
  workspaceId: number
  stdoutTail: string
  stderrTail: string
  logsTruncated: boolean
  totalOutputBytes: number
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | undefined
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  intent: 'user' | 'lifetime' | 'shutdown' | null
}

export interface ProjectRuntimeServiceDeps {
  readonly workspaces: WorkspaceRepository
  readonly gate: CapabilityGate
  readonly runtimes: ProjectRuntimeRepository
  readonly runs?: OrchestrationRepository
  readonly spawnImpl?: SpawnFn
  readonly resolveExecutable?: typeof resolveWorkerExecutable
  readonly createPreviewWindow?: (runtime: { id: number; port: number; url: string }) => PreviewWindow
  readonly now?: () => number
  /** Hard lifetime override (tests only). Defaults to 30 minutes. */
  readonly lifetimeMs?: number
  /** Bounded stop-wait override (tests only). Defaults to 5 seconds. */
  readonly stopWaitMs?: number
  /** Log-flush coalescing override (tests only). Defaults to 500 ms. */
  readonly logFlushMs?: number
  /** Rolling tail cap override (tests only). Defaults to 128 KiB. */
  readonly logTailCapBytes?: number
  readonly onUpdated?: (event: ProjectRuntimeUpdatedEvent) => void
}

/**
 * Managed project-runtime service (Stage 26, main only). Owns the full
 * lifecycle of bounded long-lived dev-server processes: exact approval
 * integration, at-most-once reservation, spawn with Stage 25 process
 * rules, rolling bounded log tails, one hard-lifetime deadline per
 * runtime, explicit human stop, bounded app-shutdown cleanup, and
 * crash-safe startup interruption. Live PIDs/handles exist only in
 * memory — never persisted. Zero provider calls.
 */
export class ProjectRuntimeService {
  private readonly spawnImpl: SpawnFn
  private readonly resolveExecutable: typeof resolveWorkerExecutable
  private readonly createPreviewWindow: ((runtime: { id: number; port: number; url: string }) => PreviewWindow) | undefined
  private readonly now: () => number
  private readonly lifetimeMs: number
  private readonly stopWaitMs: number
  private readonly logFlushMs: number
  private readonly logTailCapBytes: number
  private onUpdated: ((event: ProjectRuntimeUpdatedEvent) => void) | undefined
  private readonly live = new Map<number, LiveRuntime>()
  private readonly previews = new Map<number, PreviewWindow>()
  private readonly previewUrls = new Map<number, string>()

  constructor(private readonly deps: ProjectRuntimeServiceDeps) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn
    this.resolveExecutable = deps.resolveExecutable ?? resolveWorkerExecutable
    this.createPreviewWindow = deps.createPreviewWindow
    this.now = deps.now ?? Date.now
    this.lifetimeMs = deps.lifetimeMs ?? MAX_RUNTIME_SESSION_MS
    this.stopWaitMs = deps.stopWaitMs ?? MAX_RUNTIME_STOP_WAIT_MS
    this.logFlushMs = deps.logFlushMs ?? MIN_RUNTIME_LOG_FLUSH_MS
    this.logTailCapBytes = deps.logTailCapBytes ?? MAX_RUNTIME_LOG_TAIL_BYTES
    this.onUpdated = deps.onUpdated
  }

  /** Late-wires the renderer notification sink (set by the app root after construction). */
  setUpdatedListener(listener: ((event: ProjectRuntimeUpdatedEvent) => void) | undefined): void {
    this.onUpdated = listener
  }

  /**
   * Executes one approved runtime_start at most once. Re-parses the
   * exact persisted approval args, re-runs the gate (only
   * `requires_approval` proceeds — `allow` fails closed), returns the
   * active runtime when the workspace already owns one, otherwise
   * reserves + consumes the approval in ONE transaction BEFORE
   * spawning, then spawns exactly once and marks the session running.
   */
  async executeApprovedRuntime(input: {
    workspaceId: number
    sessionId: number
    runId: number
    approvalId: number
    argsJson: string
    argsHash: string
    now: number
  }): Promise<ApprovedRuntimeResult> {
    let program: string
    let args: readonly string[]
    let port: number
    try {
      const parsedArgs: unknown = JSON.parse(input.argsJson) as unknown
      const validated = parseRuntimeStartArgs(parsedArgs)
      program = validated.program
      args = validated.args
      port = validated.port
    } catch {
      throw new InvalidWorkerToolRequestError('approval arguments are invalid')
    }
    const decision = this.deps.gate.authorize({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: 'worker',
      capability: 'terminal.execute'
    })
    if (decision.decision === 'deny') {
      return { kind: 'denied', reason: WORKER_RUNTIME_DENY_MESSAGE }
    }
    if (decision.decision !== 'requires_approval') {
      return { kind: 'denied', reason: WORKER_RUNTIME_INVALID_POLICY_MESSAGE }
    }
    const alreadyActive = this.deps.runtimes.findActiveForWorkspace(input.workspaceId)
    if (alreadyActive !== undefined) {
      return { kind: 'active', runtime: this.toSummary(alreadyActive) }
    }
    let runtimeId: number
    try {
      ;({ runtimeId } = this.deps.runtimes.reserveStart({
        approvalId: input.approvalId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        program,
        argsJson: input.argsJson,
        argsHash: input.argsHash,
        previewPort: port,
        now: input.now
      }))
    } catch (error) {
      const active = this.deps.runtimes.findActiveForWorkspace(input.workspaceId)
      if (active !== undefined) {
        return { kind: 'active', runtime: this.toSummary(active) }
      }
      throw error
    }
    const startedAt = this.now()
    const cwd = await this.resolveWorkspaceCwd(input.workspaceId)
    if (cwd === null) {
      this.deps.runtimes.finalizeSession(runtimeId, { status: 'spawn_failed', exitCode: null, signal: null, stopReason: 'spawn_failed' }, this.now())
      this.emitWorkspace(input.workspaceId)
      return { kind: 'failed' }
    }
    const resolved = await this.resolveExecutable(program)
    if (resolved.absolutePath === null) {
      this.deps.runtimes.finalizeSession(runtimeId, { status: 'spawn_failed', exitCode: null, signal: null, stopReason: 'spawn_failed' }, this.now())
      this.emitWorkspace(input.workspaceId)
      return { kind: 'failed' }
    }
    let child: ChildProcess
    try {
      // Detached on POSIX so the runtime owns its process group and tree
      // termination reaches spawned dev-server children (Stage 26 allows
      // this safe platform abstraction; one-shot commands stay attached).
      child = this.spawnImpl(resolved.absolutePath, [...args], {
        cwd,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildWorkerCommandEnv(),
        windowsHide: true
      })
    } catch {
      this.deps.runtimes.finalizeSession(runtimeId, { status: 'spawn_failed', exitCode: null, signal: null, stopReason: 'spawn_failed' }, this.now())
      this.emitWorkspace(input.workspaceId)
      return { kind: 'failed' }
    }
    const live: LiveRuntime = {
      child,
      workspaceId: input.workspaceId,
      stdoutTail: '',
      stderrTail: '',
      logsTruncated: false,
      totalOutputBytes: 0,
      dirty: false,
      flushTimer: undefined,
      lifetimeTimer: undefined,
      intent: null
    }
    this.live.set(runtimeId, live)
    this.deps.runtimes.markRunning(runtimeId, startedAt)
    live.lifetimeTimer = setTimeout(() => {
      void this.onLifetimeExpired(runtimeId)
    }, Math.max(0, this.lifetimeMs))
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.appendLog(runtimeId, chunk, 'stdout')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.appendLog(runtimeId, chunk, 'stderr')
    })
    child.on('error', () => {
      // Dropped by stop/shutdown (row already terminal): never touch
      // persistence again — the database may already be closed.
      if (!this.live.has(runtimeId)) {
        return
      }
      try {
        this.flushLogs(runtimeId)
        const current = this.live.get(runtimeId)
        const intent = current?.intent ?? null
        if (intent === 'user' || intent === 'shutdown') {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: intent === 'user' ? 'user' : 'app_shutdown' }, this.now())
        } else if (intent === 'lifetime') {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'timed_out', exitCode: null, signal: null, stopReason: 'lifetime_limit' }, this.now())
        } else {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'spawn_failed', exitCode: null, signal: null, stopReason: 'spawn_failed' }, this.now())
        }
      } catch {
        // Best effort: shutdown races must never throw.
      }
      this.dropLive(runtimeId)
      this.emitWorkspace(input.workspaceId)
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // Dropped by stop/shutdown (row already terminal): never touch
      // persistence again — the database may already be closed.
      if (!this.live.has(runtimeId)) {
        return
      }
      try {
        this.flushLogs(runtimeId)
        const current = this.live.get(runtimeId)
        const intent = current?.intent ?? null
        if (intent === 'user' || intent === 'shutdown') {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'stopped', exitCode: code, signal: signal ?? null, stopReason: intent === 'user' ? 'user' : 'app_shutdown' }, this.now())
        } else if (intent === 'lifetime') {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'timed_out', exitCode: code, signal: signal ?? null, stopReason: 'lifetime_limit' }, this.now())
        } else {
          this.deps.runtimes.finalizeSession(runtimeId, { status: 'exited', exitCode: code, signal: signal ?? null, stopReason: 'process_exit' }, this.now())
        }
      } catch {
        // Best effort: shutdown races must never throw.
      }
      this.dropLive(runtimeId)
      this.emitWorkspace(input.workspaceId)
    })
    this.emitWorkspace(input.workspaceId)
    return { kind: 'started', runtimeId, previewUrl: previewUrlForPort(port), port }
  }

  /** Active (starting/running) runtime summary for one workspace, or null. */
  getActiveSummary(workspaceId: number): ProjectRuntimeSummary | null {
    this.requireWorkspace(workspaceId)
    const active = this.deps.runtimes.findActiveForWorkspace(workspaceId)
    return active === undefined ? null : this.toSummary(active)
  }

  /**
   * Active (starting/running) stored session for one workspace, or
   * undefined. Read-only lookup used by Stage 27 Worker observation
   * tools — no side effects, no lifetime change, no Preview action.
   */
  getActiveForWorkspace(workspaceId: number): import('./project-runtime-repository').StoredRuntimeSession | undefined {
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return undefined
    }
    if (this.deps.workspaces.findById(workspaceId) === undefined) {
      return undefined
    }
    const active = this.deps.runtimes.findActiveForWorkspace(workspaceId)
    if (active === undefined) {
      return undefined
    }
    if (active.status !== 'starting' && active.status !== 'running') {
      return undefined
    }
    return active
  }

  /**
   * Current human Live Preview URL for one runtime, or null when no
   * visible Preview exists. Used main-side to derive Worker
   * inspection targets; the Worker never supplies URLs.
   */
  getVisiblePreviewUrl(runtimeId: number): string | null {
    const window = this.previews.get(runtimeId)
    if (window === undefined || window.isDestroyed()) {
      return null
    }
    return this.previewUrls.get(runtimeId) ?? null
  }

  /** True when a non-destroyed human Preview window exists for one runtime. */
  hasVisiblePreview(runtimeId: number): boolean {
    return this.getVisiblePreviewUrl(runtimeId) !== null
  }

  /** Newest-first bounded runtime history for one workspace. */
  listRecentSummaries(workspaceId: number): ProjectRuntimeSummary[] {
    this.requireWorkspace(workspaceId)
    return this.deps.runtimes.listRecentForWorkspace(workspaceId, MAX_RECENT_RUNTIMES).map((row) => this.toSummary(row))
  }

  /**
   * Explicit human Stop. Validates workspace ownership, signals only a
   * live handle owned by THIS process, waits boundedly, then finalizes
   * stopped/user. Terminal rows return as-is; live rows without a
   * handle are never signalled (no stale-PID usage).
   */
  async stopRuntime(input: { workspaceId: number; runtimeId: number; now: number }): Promise<ProjectRuntimeSummary> {
    const row = this.requireOwnedRow(input.workspaceId, input.runtimeId)
    if (row.status !== 'starting' && row.status !== 'running') {
      return this.toSummary(row)
    }
    const live = this.live.get(input.runtimeId)
    if (live === undefined) {
      return this.toSummary(row)
    }
    live.intent = 'user'
    killProcessTree(live.child)
    await this.waitForClose(live.child, this.stopWaitMs)
    try {
      live.child.kill('SIGKILL')
    } catch {
      // Best effort on the exact handle only.
    }
    this.flushLogs(input.runtimeId)
    this.deps.runtimes.finalizeSession(input.runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'user' }, input.now)
    this.dropLive(input.runtimeId)
    this.emitWorkspace(input.workspaceId)
    const fresh = this.deps.runtimes.findById(input.runtimeId)
    return this.toSummary(fresh ?? row)
  }

  /**
   * Opens the isolated Live Preview for a running runtime. The renderer
   * supplies IDs only; main derives the exact loopback URL from the
   * persisted approved port. Closing the preview never stops the
   * runtime; reopening while active reuses a fresh window.
   */
  async openPreview(input: { workspaceId: number; runtimeId: number }): Promise<ProjectRuntimeSummary> {
    if (this.createPreviewWindow === undefined) {
      throw new InvalidWorkerToolRequestError('live preview is unavailable')
    }
    const row = this.requireOwnedRow(input.workspaceId, input.runtimeId)
    if (row.status !== 'running') {
      throw new InvalidWorkerToolRequestError('live preview requires a running runtime')
    }
    const url = previewUrlForPort(row.previewPort)
    const existing = this.previews.get(input.runtimeId)
    if (existing !== undefined && !existing.isDestroyed()) {
      return this.toSummary(row)
    }
    this.previews.delete(input.runtimeId)
    this.previewUrls.delete(input.runtimeId)
    const window = this.createPreviewWindow({ id: row.id, port: row.previewPort, url })
    wirePreviewWindow(window, row.previewPort, () => {
      this.previews.delete(input.runtimeId)
      this.previewUrls.delete(input.runtimeId)
    })
    this.previews.set(input.runtimeId, window)
    this.previewUrls.set(input.runtimeId, url)
    // Tracks the human Preview's current same-origin URL for future
    // read-only Worker inspection targets. Off-origin navigations are
    // already blocked by wirePreviewWindow; this only records allowed
    // same-origin moves and never navigates itself.
    try {
      window.webContents.on('will-navigate', (details) => {
        if (isAllowedPreviewNavigation(details.url, row.previewPort)) {
          this.previewUrls.set(input.runtimeId, details.url)
        }
      })
    } catch {
      // Best effort tracking; inspection falls back to the root.
    }
    try {
      await window.webContents.loadURL(url)
    } catch {
      // The dev server may not be ready yet — the window shows the
      // normal connection state and the user can Reload Preview.
    }
    return this.toSummary(row)
  }

  /** Reloads an open preview window. No arbitrary URL, no polling. */
  async reloadPreview(input: { workspaceId: number; runtimeId: number }): Promise<ProjectRuntimeSummary> {
    const row = this.requireOwnedRow(input.workspaceId, input.runtimeId)
    const window = this.previews.get(input.runtimeId)
    if (window === undefined || window.isDestroyed()) {
      throw new InvalidWorkerToolRequestError('no open preview for this runtime')
    }
    const allowed = isAllowedPreviewNavigation(previewUrlForPort(row.previewPort), row.previewPort)
    if (!allowed) {
      throw new InvalidWorkerToolRequestError('live preview requires a running runtime')
    }
    try {
      window.webContents.reload()
    } catch {
      throw new InvalidWorkerToolRequestError('live preview could not be reloaded')
    }
    return this.toSummary(row)
  }

  /**
   * Bounded application-shutdown cleanup: stops every live runtime tree
   * created by this process and finalizes rows as stopped/app_shutdown.
   * Never waits indefinitely — one global deadline bounds everything.
   */
  async shutdownAll(now: number): Promise<{ stopped: number }> {
    const ids = [...this.live.keys()]
    const deadline = now + MAX_RUNTIME_SHUTDOWN_MS
    for (const runtimeId of ids) {
      const live = this.live.get(runtimeId)
      if (live === undefined) {
        continue
      }
      live.intent = 'shutdown'
      killProcessTree(live.child)
      this.flushLogs(runtimeId)
      this.deps.runtimes.finalizeSession(runtimeId, { status: 'stopped', exitCode: null, signal: null, stopReason: 'app_shutdown' }, Math.min(this.now(), deadline))
      this.dropLive(runtimeId)
      this.emitWorkspace(live.workspaceId)
    }
    return { stopped: ids.length }
  }

  /**
   * One bounded startup pass: leftover starting/running rows become
   * interrupted with no process launch, no PID kill, no auto-restart,
   * and no port probe. Parked runs linked to those rows fail with safe
   * copy when a runs repository is wired.
   */
  recoverAtStartup(now: number): { interrupted: number } {
    const outcome = this.deps.runtimes.markStartingAndRunningAsInterrupted(now)
    const runs = this.deps.runs
    if (runs !== undefined) {
      for (const runId of outcome.runIds) {
        try {
          const run = runs.findRunById(runId)
          if (run !== undefined && run.status === 'waiting_for_approval') {
            runs.updateRunState({
              id: runId,
              status: 'failed',
              action: run.action,
              planSummary: run.planSummary,
              finalMessageId: run.finalMessageId,
              errorCategory: 'This runtime was active when STARK stopped and will not be restarted automatically.',
              now
            })
          }
        } catch {
          // Best effort per run.
        }
      }
    }
    return { interrupted: outcome.interrupted }
  }

  private onLifetimeExpired(runtimeId: number): void {
    const live = this.live.get(runtimeId)
    if (live === undefined) {
      return
    }
    live.intent = 'lifetime'
    killProcessTree(live.child)
    this.flushLogs(runtimeId)
    // The close handler finalizes timed_out/lifetime_limit; if the
    // process is already gone, finalize directly.
    const finalized = this.deps.runtimes.finalizeSession(runtimeId, { status: 'timed_out', exitCode: null, signal: null, stopReason: 'lifetime_limit' }, this.now())
    void finalized
    this.dropLive(runtimeId)
    this.emitWorkspace(live.workspaceId)
  }

  private appendLog(runtimeId: number, chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
    const live = this.live.get(runtimeId)
    if (live === undefined) {
      return
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const text = normalizeCommandOutput(buffer)
    if (stream === 'stdout') {
      live.stdoutTail += text
    } else {
      live.stderrTail += text
    }
    live.totalOutputBytes =
      live.totalOutputBytes > Number.MAX_SAFE_INTEGER - buffer.length
        ? Number.MAX_SAFE_INTEGER
        : live.totalOutputBytes + buffer.length
    this.trimTail(live)
    live.dirty = true
    if (live.flushTimer === undefined) {
      live.flushTimer = setTimeout(() => {
        live.flushTimer = undefined
        this.flushLogs(runtimeId)
        const current = this.live.get(runtimeId)
        this.emitWorkspace(current?.workspaceId ?? 0)
      }, Math.max(MIN_RUNTIME_LOG_FLUSH_MS, this.logFlushMs))
    }
  }

  /** Drops oldest tail text so the combined tail fits the byte cap. */
  private trimTail(live: LiveRuntime): void {
    const cap = this.logTailCapBytes
    const combined = encoder.encode(live.stdoutTail + live.stderrTail).byteLength
    if (combined <= cap) {
      return
    }
    live.logsTruncated = true
    let overflow = combined - cap
    // Dropping N chars removes at least N bytes, so one pass suffices.
    while (overflow > 0 && (live.stdoutTail !== '' || live.stderrTail !== '')) {
      if (live.stdoutTail.length >= live.stderrTail.length && live.stdoutTail !== '') {
        const drop = Math.min(overflow, live.stdoutTail.length)
        live.stdoutTail = live.stdoutTail.slice(drop)
        overflow -= drop
      } else if (live.stderrTail !== '') {
        const drop = Math.min(overflow, live.stderrTail.length)
        live.stderrTail = live.stderrTail.slice(drop)
        overflow -= drop
      } else {
        break
      }
    }
  }

  private flushLogs(runtimeId: number): void {
    const live = this.live.get(runtimeId)
    if (live === undefined || !live.dirty) {
      return
    }
    live.dirty = false
    this.deps.runtimes.updateLogTail(
      runtimeId,
      { stdoutTail: live.stdoutTail, stderrTail: live.stderrTail, logsTruncated: live.logsTruncated, totalOutputBytes: live.totalOutputBytes },
      this.now()
    )
  }

  private dropLive(runtimeId: number): void {
    const live = this.live.get(runtimeId)
    if (live === undefined) {
      return
    }
    if (live.flushTimer !== undefined) {
      clearTimeout(live.flushTimer)
    }
    if (live.lifetimeTimer !== undefined) {
      clearTimeout(live.lifetimeTimer)
    }
    this.live.delete(runtimeId)
  }

  private waitForClose(child: ChildProcess, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, Math.max(0, waitMs))
      child.on('close', finish)
      child.on('error', finish)
    })
  }

  private async resolveWorkspaceCwd(workspaceId: number): Promise<string | null> {
    const stored = this.deps.workspaces.findById(workspaceId)
    if (stored === undefined) {
      return null
    }
    try {
      const stats = await stat(stored.rootPath)
      if (!stats.isDirectory()) {
        return null
      }
      return await realpath(stored.rootPath)
    } catch {
      return null
    }
  }

  private requireWorkspace(workspaceId: number): void {
    if (!Number.isInteger(workspaceId) || workspaceId <= 0 || this.deps.workspaces.findById(workspaceId) === undefined) {
      throw new InvalidWorkerToolRequestError('workspace reference is invalid')
    }
  }

  private requireOwnedRow(workspaceId: number, runtimeId: number): StoredRuntimeSession {
    this.requireWorkspace(workspaceId)
    if (!Number.isInteger(runtimeId) || runtimeId <= 0) {
      throw new InvalidWorkerToolRequestError('runtime reference is invalid')
    }
    const row = this.deps.runtimes.findById(runtimeId)
    if (row === undefined || row.workspaceId !== workspaceId) {
      throw new InvalidWorkerToolRequestError('runtime reference is invalid')
    }
    return row
  }

  private toSummary(row: StoredRuntimeSession): ProjectRuntimeSummary {
    const live = this.live.get(row.id)
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      program: row.program,
      args: parseStoredArgs(row.argsJson),
      previewPort: row.previewPort,
      previewUrl: previewUrlForPort(row.previewPort),
      status: row.status,
      exitCode: row.exitCode,
      signal: row.signal,
      stdoutTail: live?.stdoutTail ?? row.stdoutTail,
      stderrTail: live?.stderrTail ?? row.stderrTail,
      logsTruncated: live?.logsTruncated ?? row.logsTruncated,
      totalOutputBytes: live?.totalOutputBytes ?? row.totalOutputBytes,
      stopReason: row.stopReason,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt
    }
  }

  private emitWorkspace(workspaceId: number): void {
    if (workspaceId <= 0 || this.onUpdated === undefined) {
      return
    }
    try {
      const active = this.deps.runtimes.findActiveForWorkspace(workspaceId)
      this.onUpdated({ workspaceId, runtime: active === undefined ? null : this.toSummary(active) })
    } catch {
      // Best effort notification.
    }
  }
}
