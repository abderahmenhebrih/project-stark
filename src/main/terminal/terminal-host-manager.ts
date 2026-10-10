import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTerminalHostMessage,
  parseTerminalHostMessage,
  parseTerminalHostPayloadMessage,
  type TerminalHostPayloadMessage
} from './terminal-host-protocol'

/** Hard startup bound: READY must arrive within 10 seconds. */
export const TERMINAL_HOST_STARTUP_TIMEOUT_MS = 10_000

/** Hard graceful-stop bound: SHUTDOWN_COMPLETE within 5 seconds. */
export const TERMINAL_HOST_STOP_TIMEOUT_MS = 5_000

/** Default bound for one correlated host request (create/kill). */
export const TERMINAL_HOST_REQUEST_TIMEOUT_MS = 10_000

/** Neutral STARK-owned working directory under userData. */
export const TERMINAL_HOST_RUNTIME_DIR_NAME = 'terminal-host-runtime'

export type TerminalHostState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed'

/**
 * Minimal host-process surface: the exact subset of Electron
 * UtilityProcess the broker uses (fork handle with message passing
 * and exact-handle kill). Tests inject fakes; production wraps the
 * real utilityProcess child.
 */
export interface TerminalHostProcess {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message' | 'exit', listener: (...args: Array<unknown>) => void): void
  removeAllListeners(event: 'message' | 'exit'): void
}

export interface TerminalHostForkOptions {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly execArgv: string[]
  readonly stdio: ['ignore', 'ignore', 'ignore']
  readonly serviceName: string
}

export interface TerminalHostLauncher {
  fork(modulePath: string, options: TerminalHostForkOptions): TerminalHostProcess
}

export interface TerminalHostManagerOptions {
  /** Absolute STARK-owned bootstrap file (shipped production artifact). */
  readonly bootstrapPath: string
  /** Electron userData directory (owns the neutral runtime cwd). */
  readonly userDataDir: string
  /** Process spawner (utilityProcess in production, fakes in tests). */
  readonly launcher: TerminalHostLauncher
  /** Bounds (spec defaults; tests inject short values). */
  readonly startupTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /** Internal transition log sink (state words only, never payloads). */
  readonly onLog?: (message: string) => void
}

export type TerminalHostEvent =
  | { readonly kind: 'message'; readonly message: TerminalHostPayloadMessage }
  | { readonly kind: 'shutdown-complete' }
  | { readonly kind: 'exit' }

/**
 * Main-owned Terminal Host broker: the ONLY main-side owner of the
 * human-PTY host process.
 *
 * Blocking native ConPTY operations (notably kill) execute inside the
 * host, never on Electron's main event loop — a wedged teardown
 * stalls at most the host while main keeps serving every other
 * window, IPC channel, and terminal. One host instance per manager.
 * Unexpected exits become `crashed` without restarting; a fresh host
 * starts only on the next explicit user action (never a loop).
 * Startup, shutdown, and correlated requests are hard-bounded with
 * exact-handle termination and no retries, polling, or loops.
 */
export class TerminalHostManager {
  private state: TerminalHostState = 'stopped'
  private child: TerminalHostProcess | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private startingPromise: Promise<void> | null = null
  private readonly readyWaiters = new Set<{
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }>()
  private readonly pendingRequests = new Map<
    string,
    { readonly resolve: (message: TerminalHostPayloadMessage) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
  >()
  private readonly subscribers = new Set<(event: TerminalHostEvent) => void>()
  private readonly options: TerminalHostManagerOptions

  constructor(options: TerminalHostManagerOptions) {
    this.options = options
  }

  getState(): TerminalHostState {
    return this.state
  }

  /**
   * Subscribes to host payload events and exits. Listeners persist
   * across restarts and must never throw (a throwing listener is
   * dropped for that event). Returns an unsubscribe function.
   */
  onHostEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never break lifecycle control.
      }
    }
  }

  private log(transition: string): void {
    try {
      this.options.onLog?.(`terminal-host: ${transition}`)
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

  private failAllRequests(message: string): void {
    for (const [, pending] of [...this.pendingRequests]) {
      try {
        clearTimeout(pending.timer)
      } catch {
        // Best effort.
      }
      try {
        pending.reject(new Error(message))
      } catch {
        // Reject handlers are caller-owned; never break control flow.
      }
    }
    this.pendingRequests.clear()
  }

  /** Routes one validated payload to a waiting correlated request. */
  private routeAnswer(message: TerminalHostPayloadMessage): void {
    const payload = message.payload as { readonly requestId?: unknown }
    const requestId = payload.requestId
    if (typeof requestId !== 'string') {
      return
    }
    const pending = this.pendingRequests.get(requestId)
    if (pending === undefined) {
      return
    }
    this.pendingRequests.delete(requestId)
    try {
      clearTimeout(pending.timer)
    } catch {
      // Best effort.
    }
    pending.resolve(message)
  }

  /** Permanent per-child router: answers, subscriber events, lifecycle. */
  private attachChild(child: TerminalHostProcess): void {
    child.on('message', (raw: unknown) => {
      const parsed = parseTerminalHostPayloadMessage(raw)
      if (parsed !== null) {
        this.routeAnswer(parsed)
        this.emit({ kind: 'message', message: parsed })
        return
      }
      if (parseTerminalHostMessage(raw) === 'READY' && this.state === 'starting') {
        this.clearStartupTimer()
        this.state = 'ready'
        this.log('ready')
        this.settleReadyWaiters(null)
        return
      }
      if (parseTerminalHostMessage(raw) === 'SHUTDOWN_COMPLETE') {
        this.emit({ kind: 'shutdown-complete' })
      }
    })
    child.on('exit', () => {
      this.emit({ kind: 'exit' })
      if (this.state === 'starting' || this.state === 'ready' || this.state === 'stopping') {
        this.clearStartupTimer()
        this.clearStopTimer()
        this.detach()
        this.state = 'crashed'
        this.log('crashed')
        this.failAllRequests('Terminal Host exited.')
        this.settleReadyWaiters(new Error('Terminal Host exited during startup.'))
      }
    })
  }

  private settleReadyWaiters(error: Error | null): void {
    for (const waiter of [...this.readyWaiters]) {
      try {
        if (error === null) {
          waiter.resolve()
        } else {
          waiter.reject(error)
        }
      } catch {
        // Waiter handlers are caller-owned; never break control flow.
      }
    }
    this.readyWaiters.clear()
  }

  /**
   * Ensures a ready host, starting one on demand (bounded). Called
   * only from explicit user actions (terminal create) — never from
   * crash handling, so a dead host is never resurrected in a loop.
   */
  async ensureReady(): Promise<void> {
    if (this.state === 'ready') {
      return
    }
    if (this.state === 'starting') {
      const ongoing = this.startingPromise
      if (ongoing !== null) {
        await ongoing
        return
      }
    }
    await this.start()
  }

  private async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'stopping') {
      return
    }
    if (this.state === 'starting' && this.startingPromise !== null) {
      await this.startingPromise
      return
    }
    const startupTimeoutMs = this.options.startupTimeoutMs ?? TERMINAL_HOST_STARTUP_TIMEOUT_MS
    const runtimeDir = join(this.options.userDataDir, TERMINAL_HOST_RUNTIME_DIR_NAME)
    try {
      mkdirSync(runtimeDir, { recursive: true })
    } catch {
      throw new Error('Terminal Host failed to start.')
    }
    let child: TerminalHostProcess
    try {
      child = this.options.launcher.fork(this.options.bootstrapPath, {
        env: { ...process.env },
        cwd: runtimeDir,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore'],
        serviceName: 'STARK Terminal Host'
      })
    } catch {
      throw new Error('Terminal Host failed to start.')
    }
    this.child = child
    this.state = 'starting'
    this.log('starting')
    this.attachChild(child)
    this.startingPromise = new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject })
      this.startupTimer = setTimeout(() => {
        this.killOwned()
        this.detach()
        this.state = 'crashed'
        this.log('crashed')
        this.failAllRequests('Terminal Host failed to start.')
        this.settleReadyWaiters(new Error('Terminal Host failed to start.'))
      }, startupTimeoutMs)
    })
    try {
      await this.startingPromise
    } finally {
      this.startingPromise = null
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'crashed' || this.child === null) {
      if (this.child === null && this.state !== 'crashed') {
        this.state = 'stopped'
      }
      return
    }
    if (this.state === 'starting') {
      this.clearStartupTimer()
      this.killOwned()
      this.detach()
      this.state = 'stopped'
      this.log('stopped')
      this.failAllRequests('Terminal Host stopped.')
      // Waiting ensureReady() callers must never hang: the startup
      // promise below only settles through these waiters.
      this.settleReadyWaiters(new Error('Terminal Host stopped.'))
      return
    }
    const stopTimeoutMs = this.options.stopTimeoutMs ?? TERMINAL_HOST_STOP_TIMEOUT_MS
    this.state = 'stopping'
    this.log('stopping')
    return new Promise<void>((resolve) => {
      const child = this.child
      let settled = false
      const finishStopped = (): void => {
        if (settled) {
          return
        }
        settled = true
        this.clearStopTimer()
        // SHUTDOWN_COMPLETE is a message, not process exit: the host
        // never self-terminates, so terminate the exact owned child
        // here or a live utility process lingers after every stop.
        this.killOwned()
        this.detach()
        this.state = 'stopped'
        this.log('stopped')
        resolve()
      }
      if (child === null) {
        finishStopped()
        return
      }
      // One-shot: SHUTDOWN_COMPLETE or host exit, whichever arrives
      // first (both flow through the shared subscriber channel). The
      // local flag (not state) guards double-settle: the exit path in
      // attachChild may flip state before this listener runs.
      const unsubscribe = this.onHostEvent((event) => {
        if (settled) {
          return
        }
        if (event.kind === 'exit' || event.kind === 'shutdown-complete') {
          unsubscribe()
          finishStopped()
        }
      })
      try {
        child.postMessage(buildTerminalHostMessage('SHUTDOWN'))
      } catch {
        this.killOwned()
        unsubscribe()
        finishStopped()
        return
      }
      this.stopTimer = setTimeout(() => {
        this.killOwned()
        unsubscribe()
        finishStopped()
      }, stopTimeoutMs)
    })
  }

  /**
   * Sends one correlated request (CREATE/KILL carry their own
   * requestId) and resolves with the typed host answer (bounded).
   * Rejects when the host is not ready, the bound lapses, or the
   * host exits mid-flight. Callers never retry.
   */
  request(
    message:
      | { readonly protocol: string; readonly type: 'CREATE'; readonly payload: { readonly requestId: string } }
      | { readonly protocol: string; readonly type: 'KILL'; readonly payload: { readonly requestId: string } },
    timeoutMs?: number
  ): Promise<TerminalHostPayloadMessage> {
    const child = this.child
    if (child === null || this.state !== 'ready') {
      return Promise.reject(new Error('Terminal Host is not ready.'))
    }
    const requestId = message.payload.requestId
    const bound = timeoutMs ?? this.options.requestTimeoutMs ?? TERMINAL_HOST_REQUEST_TIMEOUT_MS
    return new Promise<TerminalHostPayloadMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Terminal Host request timed out.'))
      }, bound)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      try {
        child.postMessage(message)
      } catch {
        this.pendingRequests.delete(requestId)
        clearTimeout(timer)
        reject(new Error('Terminal Host failed to receive a message.'))
      }
    })
  }

  /**
   * Fire-and-forget post for streaming operations (write/resize)
   * after local validation. Throws when the host is not ready.
   */
  notify(message: unknown): void {
    const child = this.child
    if (child === null || this.state !== 'ready') {
      throw new Error('Terminal Host is not ready.')
    }
    try {
      child.postMessage(message)
    } catch {
      throw new Error('Terminal Host failed to receive a message.')
    }
  }
}
