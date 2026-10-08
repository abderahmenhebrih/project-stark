import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import type { CapabilityGate } from '../capabilities/capability-gate'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkerCommandRepository } from './worker-command-repository'
import { resolveWorkerExecutable } from './worker-executable'
import {
  MAX_COMMAND_CLEANUP_MS,
  MAX_WORKER_COMMAND_OUTPUT_BYTES,
  MAX_WORKER_COMMAND_RUNTIME_MS
} from './worker-terminal-limits'
import {
  WORKER_TERMINAL_DENY_MESSAGE,
  WORKER_TERMINAL_INVALID_POLICY_MESSAGE,
  parseTerminalExecuteArgs,
  type ValidatedTerminalCommand
} from './worker-terminal-validation'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'

export type SpawnFn = typeof nodeSpawn

/** Terminal outcome statuses persisted on the execution row. */
export type WorkerCommandOutcomeStatus = 'completed' | 'spawn_failed' | 'timed_out' | 'output_limit'

/**
 * Normalized bounded command result. Untrusted process DATA — never
 * authority, never rendered as HTML, never promoted to instructions.
 * Carries no executable path, PID, or environment.
 */
export interface NormalizedCommandResult {
  readonly status: WorkerCommandOutcomeStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly outputBytes: number
  readonly truncated: boolean
  readonly durationMs: number
}

export type ApprovedTerminalResult =
  | { readonly kind: 'executed'; readonly executionId: number; readonly result: NormalizedCommandResult }
  | { readonly kind: 'denied'; readonly reason: string }

/** OS/tooling essentials only. Never provider keys, tokens, or STARK secrets. */
const ALLOWED_ENV_KEYS: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'LANG',
  'LC_ALL'
]

/** Minimal execution environment: allowlisted OS essentials plus CI=1. */
export function buildWorkerCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1' }
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

const OUTPUT_DECODER = new TextDecoder('utf-8', { fatal: false })

/**
 * Converts raw process bytes to bounded valid Unicode. Invalid UTF-8
 * decodes with replacement characters (never crashes); NUL and control
 * bytes outside tab/LF/CR are represented as U+FFFD so the result is
 * safe for SQLite persistence, provider encoding, and plain-text UI.
 */
export function normalizeCommandOutput(buffer: Buffer): string {
  const text = OUTPUT_DECODER.decode(buffer)
  let out = ''
  for (const char of text) {
    if (char === '\t' || char === '\n' || char === '\r') {
      out += char
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += '�'
      continue
    }
    out += char
  }
  return out
}

export interface WorkerCommandServiceDeps {
  readonly workspaces: WorkspaceRepository
  readonly gate: CapabilityGate
  readonly commands: WorkerCommandRepository
  readonly spawnImpl?: SpawnFn
  readonly resolveExecutable?: typeof resolveWorkerExecutable
  readonly now?: () => number
  /** Wall-clock budget override (tests only). Defaults to production 60s. */
  readonly timeoutMs?: number
  /** Combined output cap override (tests only). Defaults to 64 KiB. */
  readonly outputCapBytes?: number
  /** Kill-escalation bound override (tests only). Defaults to 5s. */
  readonly cleanupMs?: number
}

/**
 * Bounded non-interactive Worker command runner (Stage 25, main only).
 * Executes exactly one resolved executable + validated argv per
 * human-approved action, with the trusted Workspace root as cwd,
 * stdin closed, argv semantics (shell:false), and a sanitized
 * environment. Never touches the Stage 11 human PTY, never writes
 * files directly, never accepts transactions. Zero provider calls.
 */
export class WorkerCommandService {
  private readonly spawnImpl: SpawnFn
  private readonly resolveExecutable: typeof resolveWorkerExecutable
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly outputCapBytes: number
  private readonly cleanupMs: number

  constructor(private readonly deps: WorkerCommandServiceDeps) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn
    this.resolveExecutable = deps.resolveExecutable ?? resolveWorkerExecutable
    this.now = deps.now ?? Date.now
    this.timeoutMs = deps.timeoutMs ?? MAX_WORKER_COMMAND_RUNTIME_MS
    this.outputCapBytes = deps.outputCapBytes ?? MAX_WORKER_COMMAND_OUTPUT_BYTES
    this.cleanupMs = deps.cleanupMs ?? MAX_COMMAND_CLEANUP_MS
  }

  /**
   * Executes one approved terminal action at most once. Re-parses the
   * exact persisted approval args (never caller-supplied authority),
   * re-runs the CapabilityGate (only `requires_approval` proceeds —
   * `allow` fails closed as invalid policy), reserves the execution +
   * consumes the approval in ONE transaction BEFORE spawning, then
   * spawns exactly once and finalizes the execution row.
   */
  async executeApprovedTerminal(input: {
    workspaceId: number
    sessionId: number
    runId: number
    approvalId: number
    argsJson: string
    argsHash: string
    now: number
  }): Promise<ApprovedTerminalResult> {
    let command: ValidatedTerminalCommand
    try {
      const parsedArgs: unknown = JSON.parse(input.argsJson) as unknown
      command = parseTerminalExecuteArgs(parsedArgs)
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
      return { kind: 'denied', reason: WORKER_TERMINAL_DENY_MESSAGE }
    }
    if (decision.decision !== 'requires_approval') {
      // Persistent Allow (or any future auto-allow) is never sufficient
      // for terminal execution — fail closed without spawning.
      return { kind: 'denied', reason: WORKER_TERMINAL_INVALID_POLICY_MESSAGE }
    }
    // At-most-once reservation BEFORE any spawn. If the process crashes
    // after this commit, startup marks the row interrupted and never
    // re-executes — safety over automatic replay.
    const { executionId } = this.deps.commands.reserveExecution({
      approvalId: input.approvalId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      program: command.program,
      argsJson: input.argsJson,
      argsHash: input.argsHash,
      now: input.now
    })
    const startedAt = this.now()
    const cwd = await this.resolveWorkspaceCwd(input.workspaceId)
    if (cwd === null) {
      const result = this.emptyResult('spawn_failed', startedAt)
      this.deps.commands.finalizeExecution(executionId, { ...result, stdout: '', stderr: '' }, this.now())
      return { kind: 'executed', executionId, result }
    }
    const resolved = await this.resolveExecutable(command.program)
    if (resolved.absolutePath === null) {
      const result = this.emptyResult('spawn_failed', startedAt)
      this.deps.commands.finalizeExecution(executionId, { ...result, stdout: '', stderr: '' }, this.now())
      return { kind: 'executed', executionId, result }
    }
    this.deps.commands.markRunning(executionId, startedAt)
    const result = await this.runBounded(resolved.absolutePath, command.args, cwd, startedAt)
    this.deps.commands.finalizeExecution(
      executionId,
      {
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        outputBytes: result.outputBytes,
        truncated: result.truncated,
        durationMs: result.durationMs
      },
      this.now()
    )
    return { kind: 'executed', executionId, result }
  }

  private emptyResult(status: WorkerCommandOutcomeStatus, startedAt: number): NormalizedCommandResult {
    return {
      status,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      outputBytes: 0,
      truncated: false,
      durationMs: Math.max(0, this.now() - startedAt)
    }
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

  /**
   * Spawns one process with argv semantics and captures bounded output.
   * Exactly one spawn attempt; stdin ignored; only the spawned child
   * handle is ever signalled (never by name, never broadly). Timeout or
   * output-cap overruns terminate that child and resolve the matching
   * terminal status with no retry.
   */
  private runBounded(
    executable: string,
    args: readonly string[],
    cwd: string,
    startedAt: number
  ): Promise<NormalizedCommandResult> {
    const timeoutMs = this.timeoutMs
    const capBytes = this.outputCapBytes
    const cleanupMs = this.cleanupMs
    return new Promise<NormalizedCommandResult>((resolve) => {
      let child: ChildProcess
      try {
        child = this.spawnImpl(executable, [...args], {
          cwd,
          shell: false,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildWorkerCommandEnv(),
          windowsHide: true
        })
      } catch {
        const done = Math.max(0, this.now() - startedAt)
        resolve({
          status: 'spawn_failed', exitCode: null, signal: null,
          stdout: '', stderr: '', outputBytes: 0, truncated: false, durationMs: done
        })
        return
      }
      let settled = false
      let terminal: WorkerCommandOutcomeStatus | null = null
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let capturedBytes = 0
      let truncated = false

      const finish = (outcome: Omit<NormalizedCommandResult, 'durationMs'>): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        if (escalation !== undefined) {
          clearTimeout(escalation)
        }
        resolve({ ...outcome, durationMs: Math.max(0, this.now() - startedAt) })
      }

      // Signals ONLY the spawned child handle. No name-based or broad kills.
      const killOnlyChild = (signal: NodeJS.Signals): void => {
        try {
          child.kill(signal)
        } catch {
          // Best effort.
        }
      }

      const timer: ReturnType<typeof setTimeout> | undefined =
        timeoutMs > 0
          ? setTimeout(() => {
              terminal = 'timed_out'
              killOnlyChild('SIGTERM')
              escalation = setTimeout(() => killOnlyChild('SIGKILL'), Math.max(0, cleanupMs))
            }, timeoutMs)
          : undefined
      let escalation: ReturnType<typeof setTimeout> | undefined

      const pushChunk = (chunk: Buffer | string, sink: Buffer[]): boolean => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = capBytes - capturedBytes
        if (remaining <= 0) {
          return false
        }
        if (buffer.length <= remaining) {
          sink.push(buffer)
          capturedBytes += buffer.length
          return true
        }
        sink.push(buffer.subarray(0, remaining))
        capturedBytes += remaining
        return false
      }

      const onCapExceeded = (): void => {
        if (terminal === null) {
          terminal = 'output_limit'
          truncated = true
        }
        killOnlyChild('SIGTERM')
        if (escalation === undefined) {
          escalation = setTimeout(() => killOnlyChild('SIGKILL'), Math.max(0, cleanupMs))
        }
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return
        }
        if (!pushChunk(chunk, stdoutChunks)) {
          onCapExceeded()
        }
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (settled) {
          return
        }
        if (!pushChunk(chunk, stderrChunks)) {
          onCapExceeded()
        }
      })
      child.on('error', () => {
        const stdout = normalizeCommandOutput(Buffer.concat(stdoutChunks))
        const stderr = normalizeCommandOutput(Buffer.concat(stderrChunks))
        finish({
          status: 'spawn_failed', exitCode: null, signal: null,
          stdout, stderr, outputBytes: capturedBytes, truncated
        })
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const stdout = normalizeCommandOutput(Buffer.concat(stdoutChunks))
        const stderr = normalizeCommandOutput(Buffer.concat(stderrChunks))
        if (terminal === 'timed_out') {
          finish({ status: 'timed_out', exitCode: null, signal: signal ?? null, stdout, stderr, outputBytes: capturedBytes, truncated: true })
          return
        }
        if (terminal === 'output_limit') {
          finish({ status: 'output_limit', exitCode: code, signal: signal ?? null, stdout, stderr, outputBytes: capturedBytes, truncated: true })
          return
        }
        // A launched process that exits (even nonzero) is completed —
        // the Worker reasons about the failure; nothing re-runs.
        finish({ status: 'completed', exitCode: code, signal: signal ?? null, stdout, stderr, outputBytes: capturedBytes, truncated })
      })
    })
  }
}
