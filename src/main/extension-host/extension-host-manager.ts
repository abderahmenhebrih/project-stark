import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionHostState, ExtensionHostStatus } from '../../shared/extension-host/types'
import { buildExtensionHostEnv } from './environment'
import { ExtensionHostError } from './errors'
import { buildHostMessage, parseHostMessage } from './protocol'

/** Hard startup bound: READY must arrive within 10 seconds. */
export const EXTENSION_HOST_STARTUP_TIMEOUT_MS = 10_000

/** Hard graceful-stop bound: SHUTDOWN_COMPLETE within 5 seconds. */
export const EXTENSION_HOST_STOP_TIMEOUT_MS = 5_000

/** Neutral STARK-owned working directory under userData. */
export const EXTENSION_HOST_RUNTIME_DIR_NAME = 'extension-host-runtime'

/**
 * Minimal host-process surface: the exact subset of Electron
 * UtilityProcess the broker uses (fork handle with message passing
 * and exact-handle kill). Tests inject fakes; production wraps the
 * real utilityProcess child.
 */
export interface ExtensionHostProcess {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message' | 'exit', listener: (...args: Array<unknown>) => void): void
  removeAllListeners(event: 'message' | 'exit'): void
}

export interface ExtensionHostForkOptions {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly execArgv: string[]
  readonly stdio: ['ignore', 'ignore', 'ignore']
  readonly serviceName: string
}

export interface ExtensionHostLauncher {
  fork(modulePath: string, options: ExtensionHostForkOptions): ExtensionHostProcess
}

export interface ExtensionHostManagerOptions {
  /** Absolute STARK-owned bootstrap file (shipped production artifact). */
  readonly bootstrapPath: string
  /** Electron userData directory (owns the neutral runtime cwd). */
  readonly userDataDir: string
  /** Process spawner (utilityProcess in production, fakes in tests). */
  readonly launcher: ExtensionHostLauncher
  /** Bounds (spec defaults; tests inject short values). */
  readonly startupTimeoutMs?: number
  readonly stopTimeoutMs?: number
  /** Internal transition log sink (state words only, never payloads). */
  readonly onLog?: (message: string) => void
}

/**
 * Main-owned Extension Host broker (formatter pilot).
 *
 * One host instance per manager: start() while starting/ready (or
 * stopping) reuses current status without spawning. The host runs
 * STARK-owned bootstrap code plus, on explicit main request, the
 * single allowlisted formatter extension behind the formatter
 * module's own identity and containment checks — installed extension
 * paths are derived main-side and never enumerated here. Unexpected
 * exits become `crashed` without restarting; startup/shutdown are
 * hard-bounded with exact-handle termination and no retries,
 * polling, or loops.
 *
 * Formatter orchestration lives in the formatter service: the broker
 * exposes exactly two narrow additions beyond lifecycle — posting a
 * validated message to a ready host, and subscribing to host events
 * (messages/exit). Subscribers survive restarts (re-attached per
 * child); posting to a non-ready host throws.
 */
export type ExtensionHostEvent =
  | { readonly kind: 'message'; readonly raw: unknown }
  | { readonly kind: 'exit' }

export class ExtensionHostManager {
  private state: ExtensionHostState = 'stopped'
  private child: ExtensionHostProcess | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private pendingStart: { readonly resolve: (status: ExtensionHostStatus) => void; readonly reject: (error: Error) => void } | null = null
  private readonly subscribers = new Set<(event: ExtensionHostEvent) => void>()
  private readonly options: ExtensionHostManagerOptions

  constructor(options: ExtensionHostManagerOptions) {
    this.options = options
  }

  getStatus(): ExtensionHostStatus {
    return { state: this.state }
  }

  /**
   * Subscribes to host events (validated messages and exits) for
   * formatter orchestration. Listeners persist across restarts and
   * must never throw (a throwing listener is dropped for that event).
   * Returns an unsubscribe function.
   */
  onHostEvent(listener: (event: ExtensionHostEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: ExtensionHostEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never break lifecycle control.
      }
    }
  }

  /**
   * Posts one validated message to a ready host. Throws when the host
   * is not ready (callers start it on demand first). Payload shape and
   * size are the caller's contract (see protocol payload builders).
   */
  postToHost(message: unknown): void {
    const child = this.child
    if (child === null || this.state !== 'ready') {
      throw new ExtensionHostError('Extension Host is not ready.')
    }
    try {
      child.postMessage(message)
    } catch (error: unknown) {
      throw new ExtensionHostError('Extension Host failed to receive a message.', { cause: error })
    }
  }

  private log(transition: string): void {
    try {
      this.options.onLog?.(`extension-host: ${transition}`)
    } catch {
      // Logging must never break lifecycle control.
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
  }

  /** Terminates only the exact owned child handle. Never broad kills. */
  private killOwned(): void {
    const child = this.child
    if (child === null) {
      return
    }
    try {
      child.kill()
    } catch {
      // Best effort: the exit handler still settles state.
    }
  }

  private detach(): void {
    const child = this.child
    if (child !== null) {
      try {
        child.removeAllListeners('message')
        child.removeAllListeners('exit')
      } catch {
        // Best effort.
      }
    }
    this.child = null
  }

  async start(): Promise<ExtensionHostStatus> {
    if (this.state === 'starting' || this.state === 'ready' || this.state === 'stopping') {
      return this.getStatus()
    }
    const startupTimeoutMs = this.options.startupTimeoutMs ?? EXTENSION_HOST_STARTUP_TIMEOUT_MS
    const runtimeDir = join(this.options.userDataDir, EXTENSION_HOST_RUNTIME_DIR_NAME)
    try {
      mkdirSync(runtimeDir, { recursive: true })
    } catch (error: unknown) {
      throw new ExtensionHostError('Extension Host failed to start.', { cause: error })
    }
    let child: ExtensionHostProcess
    try {
      child = this.options.launcher.fork(this.options.bootstrapPath, {
        env: buildExtensionHostEnv(process.env),
        cwd: runtimeDir,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore'],
        serviceName: 'STARK Extension Host'
      })
    } catch (error: unknown) {
      throw new ExtensionHostError('Extension Host failed to start.', { cause: error })
    }
    this.child = child
    this.state = 'starting'
    this.log('starting')
    return new Promise<ExtensionHostStatus>((resolve, reject) => {
      this.pendingStart = { resolve, reject }
      const settleReady = (): void => {
        this.clearStartupTimer()
        this.pendingStart = null
        this.state = 'ready'
        this.log('ready')
        resolve(this.getStatus())
      }
      const settleCrashed = (error: ExtensionHostError): void => {
        this.clearStartupTimer()
        this.pendingStart = null
        this.detach()
        this.state = 'crashed'
        this.log('crashed')
        reject(error)
      }
      child.on('message', (message: unknown) => {
        const type = parseHostMessage(message)
        this.emit({ kind: 'message', raw: message })
        if (type === null) {
          return
        }
        if (type === 'READY' && this.state === 'starting') {
          settleReady()
        }
      })
      child.on('exit', () => {
        this.emit({ kind: 'exit' })
        if (this.state === 'starting') {
          settleCrashed(new ExtensionHostError('Extension Host exited during startup.'))
        } else if (this.state === 'ready') {
          this.clearStartupTimer()
          this.detach()
          this.state = 'crashed'
          this.log('crashed')
        }
      })
      this.startupTimer = setTimeout(() => {
        this.killOwned()
        settleCrashed(new ExtensionHostError('Extension Host failed to start.'))
      }, startupTimeoutMs)
    })
  }

  async stop(): Promise<ExtensionHostStatus> {
    if (this.state === 'stopped' || this.state === 'crashed' || this.state === 'stopping' || this.child === null) {
      if (this.child === null && this.state !== 'crashed') {
        this.state = 'stopped'
      }
      return this.getStatus()
    }
    if (this.state === 'starting') {
      this.clearStartupTimer()
      this.killOwned()
      this.detach()
      this.state = 'stopped'
      this.log('stopped')
      const pending = this.pendingStart
      this.pendingStart = null
      pending?.resolve(this.getStatus())
      return this.getStatus()
    }
    const stopTimeoutMs = this.options.stopTimeoutMs ?? EXTENSION_HOST_STOP_TIMEOUT_MS
    this.state = 'stopping'
    this.log('stopping')
    return new Promise<ExtensionHostStatus>((resolve) => {
      const child = this.child
      const finishStopped = (): void => {
        this.clearStopTimer()
        this.detach()
        this.state = 'stopped'
        this.log('stopped')
        resolve(this.getStatus())
      }
      if (child === null) {
        finishStopped()
        return
      }
      child.on('message', (message: unknown) => {
        this.emit({ kind: 'message', raw: message })
        if (parseHostMessage(message) === 'SHUTDOWN_COMPLETE' && this.state === 'stopping') {
          finishStopped()
        }
      })
      child.on('exit', () => {
        this.emit({ kind: 'exit' })
        if (this.state === 'stopping') {
          finishStopped()
        }
      })
      try {
        child.postMessage(buildHostMessage('SHUTDOWN'))
      } catch {
        this.killOwned()
        finishStopped()
        return
      }
      this.stopTimer = setTimeout(() => {
        this.killOwned()
        finishStopped()
      }, stopTimeoutMs)
    })
  }
}
