import type {
  TerminalHostClient,
  TerminalHostClientEvent,
  TerminalHostCreateInput,
  TerminalHostKillOutcome
} from './terminal-host-client'

/**
 * Test fake Terminal Host client (unit suites only — never production).
 *
 * Mirrors the real host contract without processes: create records
 * and resolves, write/resize record per session, kill answers with a
 * configured outcome, and tests fire DATA/EXIT/host-down explicitly
 * (including deferred exits for slow-teardown simulation). No
 * timers, no retries, no real waiting unless a test opts into a
 * deferred gate it controls.
 */

export interface FakeHostSession {
  readonly id: string
  readonly workspaceId: string | number
  readonly cwd: string
  readonly shellFile: string
  readonly written: string[]
  readonly resized: Array<{ cols: number; rows: number }>
  kills: number
  exited: boolean
}

export interface FakeTerminalHostOptions {
  /** Fail every create with a spawn error. */
  readonly failCreate?: boolean
  /** Spawn the session but then throw, simulating a lost CREATE acknowledgement (orphan drill). */
  readonly loseCreateAck?: boolean
  /** When true, create() waits until releaseCreate() before proceeding. */
  readonly deferCreate?: boolean
  /** Answer every kill with this outcome (default 'initiated'). */
  readonly killOutcome?: TerminalHostKillOutcome
  /** When true, kill() returns a promise resolved only via releaseKill(). */
  readonly deferKill?: boolean
  /** Fail shutdown. */
  readonly failShutdown?: boolean
}

export interface FakeTerminalHost extends TerminalHostClient {
  readonly sessions: Map<string, FakeHostSession>
  readonly created: TerminalHostCreateInput[]
  readonly shutdowns: number
  fireData(sessionId: string, data: string): void
  fireExit(sessionId: string, exitCode: number | null, signal: number | null): void
  fireHostDown(): void
  releaseKill(): void
  releaseCreate(): void
}

export function createFakeTerminalHostClient(options: FakeTerminalHostOptions = {}): FakeTerminalHost {
  const sessions = new Map<string, FakeHostSession>()
  const created: TerminalHostCreateInput[] = []
  const listeners = new Set<(event: TerminalHostClientEvent) => void>()
  let shutdowns = 0
  let killWaiters: Array<() => void> = []
  let createWaiters: Array<() => void> = []

  function emit(event: TerminalHostClientEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Listener failures must never break the fake.
      }
    }
  }

  return {
    sessions,
    created,
    get shutdowns() {
      return shutdowns
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    create: async (input: TerminalHostCreateInput) => {
      created.push(input)
      if (options.deferCreate === true) {
        await new Promise<void>((resolve) => {
          createWaiters.push(resolve)
        })
      }
      if (options.failCreate === true) {
        throw new Error('Terminal Host failed to start the terminal.')
      }
      sessions.set(input.sessionId, {
        id: input.sessionId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        written: [],
        resized: [],
        kills: 0,
        exited: false
      })
      if (options.loseCreateAck === true) {
        throw new Error('Terminal Host acknowledgement lost.')
      }
    },
    write: (sessionId: string, data: string) => {
      sessions.get(sessionId)?.written.push(data)
    },
    resize: (sessionId: string, cols: number, rows: number) => {
      sessions.get(sessionId)?.resized.push({ cols, rows })
    },
    kill: async (sessionId: string): Promise<TerminalHostKillOutcome> => {
      if (options.deferKill === true) {
        await new Promise<void>((resolve) => {
          killWaiters.push(resolve)
        })
      }
      const tracked = sessions.get(sessionId)
      if (tracked === undefined) {
        return 'gone'
      }
      tracked.kills += 1
      return options.killOutcome ?? 'initiated'
    },
    shutdown: async () => {
      shutdowns += 1
      if (options.failShutdown === true) {
        throw new Error('Terminal Host failed to stop.')
      }
    },
    fireData: (sessionId: string, data: string) => {
      emit({ kind: 'data', sessionId, data })
    },
    fireExit: (sessionId: string, exitCode: number | null, signal: number | null) => {
      const tracked = sessions.get(sessionId)
      if (tracked !== undefined) {
        tracked.exited = true
      }
      emit({ kind: 'exit', sessionId, exitCode, signal })
    },
    fireHostDown: () => {
      emit({ kind: 'host-down' })
    },
    releaseKill: () => {
      const waiting = killWaiters
      killWaiters = []
      for (const resolve of waiting) {
        resolve()
      }
    },
    releaseCreate: () => {
      const waiting = createWaiters
      createWaiters = []
      for (const resolve of waiting) {
        resolve()
      }
    }
  }
}
