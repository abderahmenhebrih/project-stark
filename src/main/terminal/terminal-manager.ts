import { randomUUID } from 'node:crypto'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSession
} from '../../shared/terminal/types'
import {
  InvalidTerminalRequestError,
  TerminalCloseFailedError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalOwnershipError,
  TerminalUnavailableError
} from './errors'
import {
  MAX_HUMAN_TERMINALS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SESSION_ID_LENGTH,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS
} from './limits'
import type { TerminalHostClient } from './terminal-host-client'
import { splitOutputForIpc } from './pty-adapter'

/** Main → owner-renderer event sink (wired to WebContents.send by IPC). */
export interface TerminalEventSink {
  sendData: (ownerWebContentsId: number, event: TerminalDataEvent) => void
  sendExit: (ownerWebContentsId: number, event: TerminalExitEvent) => void
}

interface ManagedSession {
  readonly session: TerminalSession
  readonly ownerWebContentsId: number
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
 * Human-terminal lifecycle + ownership broker (multi-terminal).
 *
 * This class owns NO node-pty handles: every PTY lives in the
 * dedicated Terminal Host process behind TerminalHostClient, so a
 * blocking native ConPTY operation (notably kill on Windows, measured
 * at ~2–5s on Electron main) can never stall Electron's main event
 * loop. Main stays a narrow broker: shell policy, workspace cwd,
 * environment, opaque ids, per-owner caps, and ownership checks all
 * remain here; the host only executes validated commands for ids
 * main minted.
 *
 * Each owning WebContents may hold up to MAX_HUMAN_TERMINALS live
 * terminals with stable opaque IDs. Every creation spawns a new,
 * independent PTY — never reusing, evicting, or touching a running
 * one. Every operation verifies ownership. PTY output streams only
 * to the owning WebContents in bounded chunks; main keeps no
 * unbounded history buffer. Exit is delivered once per session,
 * then that session is removed.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly ownerIndex = new Map<number, Set<string>>()

  constructor(
    private readonly host: TerminalHostClient,
    private readonly sink: TerminalEventSink
  ) {
    this.host.onEvent((event) => {
      if (event.kind === 'data') {
        this.handleHostData(event.sessionId, event.data)
      } else if (event.kind === 'exit') {
        this.handleHostExit(event.sessionId, event.exitCode, event.signal)
      } else {
        this.handleHostDown()
      }
    })
  }

  /** Active session count (for diagnostics/tests; not exposed to UI). */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Spawns one new independent terminal for the owning renderer.
   * Always creates (never returns an existing session); past the
   * per-owner cap it throws before spawning — no eviction, never
   * silently killing a running terminal.
   */
  async createSession(input: {
    ownerWebContentsId: number
    workspaceId: number
    cwd: string
    shellFile: string
    shellArgs: readonly string[]
    shellLabel: string
    cols: number
    rows: number
  }): Promise<TerminalSession> {
    return this.spawnSession({ ...input, env: {} })
  }

  /**
   * Production creation with the real environment-bearing spawn. The
   * manager core above spawns with an empty env so unit tests stay
   * hermetic; production passes env through this seam.
   */
  async createSessionWithEnv(
    input: Parameters<TerminalManager['createSession']>[0] & { env: Record<string, string> }
  ): Promise<TerminalSession> {
    return this.spawnSession(input)
  }

  private async spawnSession(
    input: Parameters<TerminalManager['createSession']>[0] & { env: Record<string, string> }
  ): Promise<TerminalSession> {
    if (!isValidDimensions(input.cols, input.rows)) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    this.pruneOwnerIndex(input.ownerWebContentsId)
    if (this.liveCountForOwner(input.ownerWebContentsId) >= MAX_HUMAN_TERMINALS) {
      throw new TerminalLimitError()
    }
    const id = randomUUID()
    try {
      await this.host.create({
        sessionId: id,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        shellArgs: input.shellArgs,
        cols: input.cols,
        rows: input.rows,
        env: input.env
      })
    } catch {
      throw new TerminalUnavailableError()
    }
    const session: TerminalSession = {
      id,
      workspaceId: input.workspaceId,
      shell: input.shellLabel,
      running: true
    }
    const managed: ManagedSession = {
      session,
      ownerWebContentsId: input.ownerWebContentsId,
      running: true,
      exitDelivered: false
    }
    this.sessions.set(id, managed)
    let owned = this.ownerIndex.get(input.ownerWebContentsId)
    if (owned === undefined) {
      owned = new Set<string>()
      this.ownerIndex.set(input.ownerWebContentsId, owned)
    }
    owned.add(id)
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
    this.host.write(sessionId, data)
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
    this.host.resize(sessionId, cols as number, rows as number)
  }

  /**
   * Two-phase close contract: validates ownership, asks the host to
   * terminate exactly this PTY, and maps the host outcome —
   * `initiated` marks closing and returns promptly (exit finalizes
   * later), `gone` removes and reports NotFound (renderer finalizes),
   * `failed` throws a close error (renderer restores the terminal).
   * Never waits for the shell exit itself.
   */
  async killSession(ownerWebContentsId: number, sessionId: unknown): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      throw new InvalidTerminalRequestError('terminal session is invalid')
    }
    const managed = this.requireOwnedSession(ownerWebContentsId, sessionId)
    if (!managed.running) {
      this.removeSession(managed.session.id)
      throw new TerminalNotFoundError()
    }
    const outcome = await this.host.kill(sessionId)
    if (outcome === 'gone') {
      this.removeSession(managed.session.id)
      throw new TerminalNotFoundError()
    }
    if (outcome !== 'initiated') {
      throw new TerminalCloseFailedError()
    }
    // Exit callback performs authoritative removal; this marks the
    // intent so post-exit writes are rejected even if exit is slow.
    managed.running = false
  }

  /** Bounded cleanup when an owning renderer is destroyed: no orphans. */
  handleWebContentsDestroyed(ownerWebContentsId: number): void {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return
    }
    for (const sessionId of [...owned]) {
      if (!this.sessions.has(sessionId)) {
        continue
      }
      // Fire-and-forget exact kills; local bookkeeping drops now
      // while the host processes termination. App-quit shutdown
      // follows with a bounded host stop as the backstop.
      try {
        void this.host.kill(sessionId).catch(() => {})
      } catch {
        // Best effort during teardown.
      } finally {
        this.removeSession(sessionId)
      }
    }
  }

  /** Bounded shutdown of every session (app quit path). */
  async shutdownAll(): Promise<void> {
    try {
      await this.host.shutdown()
    } catch {
      // Best effort; removal below is authoritative and bounded.
    } finally {
      this.sessions.clear()
      this.ownerIndex.clear()
    }
  }

  /** A running session for an owner, if any (insertion order). */
  findActiveForOwner(ownerWebContentsId: number): TerminalSession | undefined {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return undefined
    }
    for (const sessionId of owned) {
      const managed = this.sessions.get(sessionId)
      if (managed !== undefined && managed.running) {
        return managed.session
      }
    }
    return undefined
  }

  /** Live session count for an owner (cap accounting). */
  liveCountForOwner(ownerWebContentsId: number): number {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return 0
    }
    let count = 0
    for (const sessionId of owned) {
      if (this.sessions.get(sessionId)?.running === true) {
        count += 1
      }
    }
    return count
  }

  /**
   * Drops index entries for sessions that no longer exist, so a dead
   * session never blocks (or inflates) cap accounting.
   */
  private pruneOwnerIndex(ownerWebContentsId: number): void {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return
    }
    for (const sessionId of [...owned]) {
      if (!this.sessions.has(sessionId)) {
        owned.delete(sessionId)
      }
    }
    if (owned.size === 0) {
      this.ownerIndex.delete(ownerWebContentsId)
    }
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

  private handleHostData(sessionId: string, data: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || !managed.running) {
      return
    }
    const chunks = splitOutputForIpc(data, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    for (const chunk of chunks) {
      this.sink.sendData(managed.ownerWebContentsId, { sessionId, data: chunk })
    }
  }

  private handleHostExit(sessionId: string, exitCode: number | null, signal: number | null): void {
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

  /**
   * Host process died: every tracked PTY died with it. Each owner
   * gets one honest exit per session (exitCode unknown); nothing
   * restarts — the next explicit New Terminal starts a fresh host.
   */
  private handleHostDown(): void {
    for (const [sessionId, managed] of [...this.sessions.entries()]) {
      if (managed.exitDelivered) {
        continue
      }
      managed.exitDelivered = true
      managed.running = false
      try {
        this.sink.sendExit(managed.ownerWebContentsId, { sessionId, exitCode: null, signal: null })
      } catch {
        // Best effort streaming.
      } finally {
        this.removeSession(sessionId)
      }
    }
  }

  private removeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed !== undefined) {
      const owned = this.ownerIndex.get(managed.ownerWebContentsId)
      owned?.delete(sessionId)
      if (owned !== undefined && owned.size === 0) {
        this.ownerIndex.delete(managed.ownerWebContentsId)
      }
    }
    this.sessions.delete(sessionId)
  }
}
