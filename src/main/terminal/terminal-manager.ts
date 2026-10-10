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
  /**
   * Owner renderer is gone (window destroyed): bookkeeping is
   * RETAINED until EXIT reaps it — never dropped while a live PTY
   * may exist. All front-door ops reject with NotFound; EXIT and
   * host-down still remove normally.
   */
  ownerGone: boolean
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
  /**
   * Creates in flight per owner (session ids SENT to the host but not
   * yet tracked). Lets window-destroyed cleanup recognize a session
   * that materializes after its owner died. Bounded: entries live
   * only until their own create settles.
   */
  private readonly pendingCreates = new Map<number, Set<string>>()
  /**
   * Owners destroyed while a create was in flight. Bounded: an entry
   * exists only while its owner has pending creates; removed when the
   * last one settles.
   */
  private readonly deadOwners = new Set<number>()

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
    this.registerPendingCreate(input.ownerWebContentsId, id)
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
      this.unregisterPendingCreate(input.ownerWebContentsId, id)
      // Uncertain result: the host may still own a live PTY for this
      // id (CREATE ack lost/timed out after a successful spawn).
      // Exact scoped cleanup of that one session before failing —
      // a `gone` answer is the common no-op; never throws.
      try {
        await this.host.kill(id)
      } catch {
        // Best effort; host-down reaps everything regardless.
      }
      throw new TerminalUnavailableError()
    }
    // Dead-owner check runs BEFORE unregistering: the unregister
    // drops the dead mark once no creates remain in flight.
    const ownerDiedMidCreate = this.deadOwners.has(input.ownerWebContentsId)
    this.unregisterPendingCreate(input.ownerWebContentsId, id)
    if (ownerDiedMidCreate) {
      // Owner died mid-create: never track a session for a dead
      // renderer. Exact cleanup of the just-created PTY instead.
      try {
        await this.host.kill(id)
      } catch {
        // Best effort; EXIT/host-down still reaps when it can.
      }
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
      exitDelivered: false,
      ownerGone: false
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
    // EXIT (or host-down) may win the race while the kill is in
    // flight and remove bookkeeping first: a session that
    // disappeared because it exited is already_gone/success — never
    // a termination failure. Ownership/security checks above stay
    // exact; only this post-await disappearance is normalized.
    if (this.sessions.get(sessionId) === undefined) {
      throw new TerminalNotFoundError()
    }
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

  /**
   * Bounded cleanup when an owning renderer is destroyed.
   *
   * Bookkeeping is RETAINED (marked ownerGone) until EXIT or
   * host-down reaps each session: dropping it while a kill is
   * unconfirmed would orphan a live PTY with no owner record. EXIT
   * delivery to the dead owner is a sink no-op; removal is normal.
   */
  handleWebContentsDestroyed(ownerWebContentsId: number): void {
    if (this.pendingCreates.has(ownerWebContentsId)) {
      this.deadOwners.add(ownerWebContentsId)
    }
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return
    }
    for (const sessionId of [...owned]) {
      const managed = this.sessions.get(sessionId)
      if (managed === undefined) {
        continue
      }
      managed.ownerGone = true
      // Initiate exact termination; the EXIT callback performs
      // authoritative removal. App-quit shutdown follows with a
      // bounded host stop as the backstop.
      try {
        void this.host.kill(sessionId).catch(() => {})
      } catch {
        // Best effort during teardown.
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

  /** A running session for a live owner, if any (insertion order). */
  findActiveForOwner(ownerWebContentsId: number): TerminalSession | undefined {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return undefined
    }
    for (const sessionId of owned) {
      const managed = this.sessions.get(sessionId)
      if (managed !== undefined && managed.running && !managed.ownerGone) {
        return managed.session
      }
    }
    return undefined
  }

  /**
   * Tracked resource count for an owner (cap accounting). Counts every
   * tracked session — including closing-but-not-yet-exited ones whose
   * ConPTY still physically exists — so at most 8 real resources exist
   * per owner. Dead-owner sessions never count against a recycled id.
   */
  liveCountForOwner(ownerWebContentsId: number): number {
    const owned = this.ownerIndex.get(ownerWebContentsId)
    if (owned === undefined) {
      return 0
    }
    let count = 0
    for (const sessionId of owned) {
      const managed = this.sessions.get(sessionId)
      if (managed !== undefined && !managed.ownerGone) {
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

  private registerPendingCreate(ownerWebContentsId: number, sessionId: string): void {
    let pending = this.pendingCreates.get(ownerWebContentsId)
    if (pending === undefined) {
      pending = new Set<string>()
      this.pendingCreates.set(ownerWebContentsId, pending)
    }
    pending.add(sessionId)
  }

  private unregisterPendingCreate(ownerWebContentsId: number, sessionId: string): void {
    const pending = this.pendingCreates.get(ownerWebContentsId)
    if (pending === undefined) {
      return
    }
    pending.delete(sessionId)
    if (pending.size === 0) {
      this.pendingCreates.delete(ownerWebContentsId)
      this.deadOwners.delete(ownerWebContentsId)
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
    if (managed.ownerGone) {
      throw new TerminalNotFoundError()
    }
    return managed
  }

  private handleHostData(sessionId: string, data: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed === undefined || !managed.running || managed.ownerGone) {
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
