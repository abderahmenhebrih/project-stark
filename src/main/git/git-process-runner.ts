import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { GIT_COMMAND_TIMEOUT_MS } from './limits'
import { GitDiffTooLargeError, GitStatusTooLargeError, GitTimeoutError, GitUnavailableError } from './errors'

/**
 * Bounded Git process runner (main process only, never exposed).
 *
 * Guarantees:
 * - invokes only the `git` executable via argument arrays (shell: false)
 * - trusted main-resolved cwd
 * - stdin ignored/non-interactive (stdio ['ignore','pipe','pipe'])
 * - non-interactive environment (GIT_TERMINAL_PROMPT=0, GIT_PAGER=cat,
 *   PAGER=cat, GIT_OPTIONAL_LOCKS=0)
 * - bounded stdout/stderr (per-stream cap; overflow kills that process)
 * - hard timeout (kills only that Git process; no broad kills)
 * - single attempt per call (no retries here; callers must not retry)
 */

export type SpawnFn = typeof nodeSpawn

export interface GitRunResult {
  readonly exitCode: number | null
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly timedOut: boolean
}

export interface GitRunOptions {
  /** Trusted main-resolved working directory. */
  readonly cwd: string
  /** Fixed argument array built entirely in main (no renderer input). */
  readonly args: readonly string[]
  /** Wall-clock budget; defaults to GIT_COMMAND_TIMEOUT_MS. */
  readonly timeoutMs?: number
  /** Per-stream output cap in bytes. */
  readonly maxOutputBytes: number
  /** Classifies an over-limit abort as status vs diff copy. */
  readonly overflowKind?: 'status' | 'diff'
}

function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0'
  }
}

function isOverflowKind(value: unknown): value is 'status' | 'diff' {
  return value === 'status' || value === 'diff'
}

export class GitProcessRunner {
  private readonly gitExecutable: string
  private readonly spawnImpl: SpawnFn
  private readonly defaultTimeoutMs: number

  constructor(options?: { readonly gitExecutable?: string; readonly spawnImpl?: SpawnFn; readonly timeoutMs?: number }) {
    this.gitExecutable = options?.gitExecutable ?? 'git'
    this.spawnImpl = options?.spawnImpl ?? nodeSpawn
    this.defaultTimeoutMs = options?.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS
  }

  /**
   * Runs one fixed Git invocation with hard bounds. Exactly one spawn;
   * never retries. Throws GitUnavailableError (spawn failure),
   * GitTimeoutError (timeout), or GitStatusTooLarge/GitDiffTooLarge
   * (output cap). Returns structured exit information otherwise.
   */
  runGit(options: GitRunOptions): Promise<GitRunResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const maxBytes = options.maxOutputBytes
    const overflowKind = isOverflowKind(options.overflowKind) ? options.overflowKind : 'status'
    return new Promise<GitRunResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawnImpl(this.gitExecutable, [...options.args], {
          cwd: options.cwd,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildGitEnv(),
          windowsHide: true
        })
      } catch (error) {
        reject(new GitUnavailableError({ cause: error }))
        return
      }
      let settled = false
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutOverflow = false
      let stderrOverflow = false

      const finish = (fn: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        fn()
      }

      const killOnlyChild = (): void => {
        try {
          child.kill()
        } catch {
          // Best effort: only this Git process is signalled, never
          // broadly killing node/electron/git processes.
        }
      }

      const timer: ReturnType<typeof setTimeout> | undefined =
        timeoutMs > 0
          ? setTimeout(() => {
              killOnlyChild()
              finish(() => {
                reject(new GitTimeoutError())
              })
            }, timeoutMs)
          : undefined
      // The timeout holds the event loop briefly (bounded by timeoutMs)
      // so a hung git.exe can always be reaped; no unref here because
      // an unref'd timer would let the loop exit before firing.

      const onOverflow = (): void => {
        killOnlyChild()
        finish(() => {
          reject(overflowKind === 'diff' ? new GitDiffTooLargeError() : new GitStatusTooLargeError())
        })
      }

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled || stdoutOverflow) {
          return
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stdoutBytes += buffer.length
        if (stdoutBytes > maxBytes) {
          stdoutOverflow = true
          onOverflow()
          return
        }
        stdoutChunks.push(buffer)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (settled || stderrOverflow) {
          return
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stderrBytes += buffer.length
        if (stderrBytes > maxBytes) {
          stderrOverflow = true
          onOverflow()
          return
        }
        stderrChunks.push(buffer)
      })
      child.on('error', (error: unknown) => {
        finish(() => {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('ENOENT')) {
            reject(new GitUnavailableError({ cause: error }))
            return
          }
          reject(new GitUnavailableError({ cause: error }))
        })
      })
      child.on('close', (code: number | null) => {
        finish(() => {
          resolve({
            exitCode: code,
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            timedOut: false
          })
        })
      })
    })
  }
}
