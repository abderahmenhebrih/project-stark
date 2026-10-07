import { randomUUID } from 'node:crypto'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession
} from '../../shared/terminal/types'
import {
  InvalidTerminalRequestError,
  TerminalNotFoundError,
  TerminalOwnershipError
} from './errors'
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SESSION_ID_LENGTH,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS
} from './limits'
import { splitOutputForIpc, type PtyFactory, type PtyHandle } from './pty-adapter'

/** Main → owner-renderer event sink (wired to WebContents.send by IPC). */
export interface TerminalEventSink {
  sendData: (ownerWebContentsId: number, event: TerminalDataEvent) => void
  sendExit: (ownerWebContentsId: number, event: TerminalExitEvent) => void
}

interface ManagedSession {
  readonly session: TerminalSession
  readonly ownerWebContentsId: number
  readonly pty: PtyHandle
  running: boolean
  exitDelivered: boolean
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(value)
  )
}

function isValidDimensions(cols: unknown, rows: unknown): cols is number {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_TERMINAL_COLS &&
    cols <= MAX_TERMINAL_COLS &&
    rows >= MIN_TERMINAL_ROWS &&
    rows <= MAX_TERMINAL_ROWS
  )
}

function inputByteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}

/**
 * Session lifecycle + ownership (Stage 11).
 *
 * One active terminal per owning WebContents: requesting Start while
 * one already runs returns the existing active session (no hidden
 * accumulation). Every operation verifies ownership — a renderer that
 * learns another session ID cannot write/resize/kill it. PTY output
 * streams only to the owning WebContents in bounded chunks; main keeps
 * no unbounded history buffer. Exit is delivered once, then the
 * session is removed.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly ownerIndex = new Map<number, string>()

  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly sink: TerminalEventSink
  ) {}

  /** Active session count (for diagnostics/tests; not exposed to UI). */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Creates (or returns the existing) terminal for the owning renderer.
   * Spawning itself is injected, so tests never touch the native binary.
   */
  createSession(input: {
    ownerWebContentsId: number
    workspaceId: number
    cwd: string
    shellFile: string
    shellArgs: readonly string[]
    shellLabel: string
    cols: number
    rows: number
  }): TerminalSession {
    if (!isValidDimensions(input.cols, input.rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    const existingId = this.ownerIndex.get(input.ownerWebContentsId)
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId)
      if (existing !== undefined && existing.running) {
        return existing.session
      }
      // Stale index entry: fall through and replace it.
      this.sessions.delete(existingId)
      this.ownerIndex.delete(input.ownerWebContentsId)
    }
    const id = randomUUID()
    const pty = this.ptyFactory.spawn(input.shellFile, input.shellArgs, {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: {}
    })
    const session: TerminalSession = {
      id,
      workspaceId: input.workspaceId,
      shell: input.shellLabel,
      running: true
    }
    const managed: ManagedSession = {
      session,
      ownerWebContentsId: input.ownerWebContentsId,
      pty,
      running: true,
      exitDelivered: false
    }
    this.sessions.set(id, managed)
    this.ownerIndex.set(input.ownerWebContentsId, id)
    pty.onData((data) => {
      this.handlePtyData(id, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.handlePtyExit(id, exitCode, signal)
    })
    return session
  }

  /**
   * Attaches the real environment-bearing spawn for production use:
   * the manager core above spawns with an empty env so unit tests stay
   * hermetic; production passes env through this seam. Kept minimal by
   * design — no extra ceremony beyond the boundary.
   */
  createSessionWithEnv(
    input: Parameters<TerminalManager['createSession']>[0] & { env: Record<string, string> }
  ): TerminalSession {
    if (!isValidDimensions(input.cols, input.rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    const existingId = this.ownerIndex.get(input.ownerWebContentsId)
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId)
      if (existing !== undefined && existing.running) {
        return existing.session
      }
      this.sessions.delete(existingId)
      this.ownerIndex.delete(input.ownerWebContentsId)
    }
    const id = randomUUID()
    const pty = this.ptyFactory.spawn(input.shellFile, input.shellArgs, {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env
    })
    const session: TerminalSession = {
      id,
      workspaceId: input.workspaceId,
      shell: input.shellLabel,
      running: true
    }
    const managed: ManagedSession = {
      session,
      ownerWebContentsId: input.ownerWebContentsId,
      pty,
      running: true,
      exitDelivered: false
    }
    this.sessions.set(id, managed)
    this.ownerIndex.set(input.ownerWebContentsId, id)
    pty.onData((data) => {
      this.handlePtyData(id, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      this.handlePtyExit(id, exitCode, signal)
    })
    return session
  }

  writeSession(ownerWebContentsId: number, sessionId: unknown, data: unknown): void {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    if (typeof data !== 'string') {
      throw new InvalidTerminalRequestError('terminal input must be a string')
    }
    if (inputByteLength(data) > MAX_TERMINAL_INPUT_BYTES) {
      throw new InvalidTerminalRequestError('terminal input is too large')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      throw new TerminalNotFoundError()
    }
    managed.pty.write(data)
  }

  resizeSession(ownerWebContentsId: number, sessionId: unknown, cols: unknown, rows: unknown): void {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    if (!isValidDimensions(cols, rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      throw new TerminalNotFoundError()
    }
    managed.pty.resize(cols as number, rows as number)
  }

  killSession(ownerWebContentsId: number, sessionId: unknown): void {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      this.removeSession(managed.session.id)
      throw new TerminalNotFoundError()
    }
    try {
      managed.pty.kill()
    } finally {
      // Exit callback performs authoritative removal; this marks the
      // intent so post-exit writes are rejected even if exit is slow.
      managed.running = false
    }
  }

  /** Bounded cleanup when an owning renderer is destroyed: no orphans. */
  handleWebContentsDestroyed(ownerWebContentsId: number): void {
    const sessionId = this.ownerIndex.get(ownerWebContentsId)
    if (sessionId === undefined) {
      return
    }
    const managed = this.sessions.get(sessionId)
    if (managed === undefined) {
      this.ownerIndex.delete(ownerWebContentsId)
      return
    }
    try {
      if (managed.running) {
        managed.pty.kill()
      }
    } catch {
      // Best effort during teardown; removal below is authoritative.
    } finally {
      this.removeSession(sessionId)
    }
  }

  /** Bounded shutdown of every session (app quit path). */
  shutdownAll(): void {
    for (const [sessionId, managed] of [...this.sessions.entries()]) {
      try {
        if (managed.running) {
          managed.pty.kill()
        }
      } catch {
        // Best effort; removal is authoritative and bounded.
      } finally {
        this.removeSession(sessionId)
      }
    }
  }

  /** Session for an owner, if one is actively running. */
  findActiveForOwner(ownerWebContentsId: number): TerminalSession | undefined {
    const sessionId = this.ownerIndex.get(ownerWebContentsId)
    if (sessionId === undefined) {
      return undefined
    }
    const managed = this.sessions.get(sessionId)
    return managed !== undefined && managed.running ? managed.session : undefined
  }

  private requireOwnedSession(ownerWebContentsId: number, sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined) {
      throw new TerminalNotFoundError()
    }
    if (managed.ownerWebContentsId !== ownerWebContentsId) {
      throw new TerminalOwnershipError()
    }
    return managed
  }

  private handlePtyData(sessionId: string, data: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || !managed.running) {
      return
    }
    const chunks = splitOutputForIpc(data, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    for (const chunk of chunks) {
      this.sink.sendData(managed.ownerWebContentsId, { sessionId, data: chunk })
    }
  }

  private handlePtyExit(sessionId: string, exitCode: number | null, signal: number | null): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || managed.exitDelivered) {
      return
    }
    managed.exitDelivered = true
    managed.running = false
    try {
      this.sink.sendExit(managed.ownerWebContentsId, { sessionId, exitCode, signal })
    } finally {
      this.removeSession(sessionId)
    }
  }

  private removeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed !== undefined && this.ownerIndex.get(managed.ownerWebContentsId) === sessionId) {
      this.ownerIndex.delete(managed.ownerWebContentsId)
    }
    this.sessions.delete(sessionId)
  }
}
