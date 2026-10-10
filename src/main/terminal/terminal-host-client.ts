import { randomUUID } from 'node:crypto'
import { buildTerminalHostPayloadMessage } from './terminal-host-protocol'
import { TerminalHostManager } from './terminal-host-manager'

/** Exact outcome of one host KILL request (two-phase close contract). */
export type TerminalHostKillOutcome = 'initiated' | 'gone' | 'failed'

export interface TerminalHostCreateInput {
  readonly sessionId: string
  readonly workspaceId: number
  readonly cwd: string
  readonly shellFile: string
  readonly shellArgs: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly env: Record<string, string>
}

export type TerminalHostClientEvent =
  | { readonly kind: 'data'; readonly sessionId: string; readonly data: string }
  | { readonly kind: 'exit'; readonly sessionId: string; readonly exitCode: number | null; readonly signal: number | null }
  | { readonly kind: 'host-down' }

/**
 * Narrow client over the Terminal Host process. The broker owns all
 * policy (shell choice, cwd, caps, ownership); this layer only moves
 * validated commands and typed events. Tests inject fakes (including
 * wedged hosts); production wraps the real manager.
 */
export interface TerminalHostClient {
  create(input: TerminalHostCreateInput): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  kill(sessionId: string): Promise<TerminalHostKillOutcome>
  shutdown(): Promise<void>
  onEvent(listener: (event: TerminalHostClientEvent) => void): () => void
}

/**
 * Production client: correlates host answers, maps outcomes, and
 * translates host events for the broker. Request bounds come from
 * the manager; callers never retry.
 */
export class TerminalProcessClient implements TerminalHostClient {
  private readonly subscribers = new Set<(event: TerminalHostClientEvent) => void>()

  constructor(private readonly manager: TerminalHostManager) {
    this.manager.onHostEvent((event) => {
      if (event.kind === 'exit') {
        this.emit({ kind: 'host-down' })
        return
      }
      if (event.kind !== 'message') {
        return
      }
      const message = event.message
      if (message.type === 'DATA') {
        this.emit({ kind: 'data', sessionId: message.payload.sessionId, data: message.payload.data })
      } else if (message.type === 'EXIT') {
        this.emit({
          kind: 'exit',
          sessionId: message.payload.sessionId,
          exitCode: message.payload.exitCode,
          signal: message.payload.signal
        })
      }
    })
  }

  onEvent(listener: (event: TerminalHostClientEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: TerminalHostClientEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event)
      } catch {
        // Subscriber failures must never break the client.
      }
    }
  }

  async create(input: TerminalHostCreateInput): Promise<void> {
    await this.manager.ensureReady()
    const requestId = randomUUID()
    const answer = await this.manager.request(
      buildTerminalHostPayloadMessage('CREATE', {
        requestId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        shellFile: input.shellFile,
        shellArgs: input.shellArgs,
        cols: input.cols,
        rows: input.rows,
        env: input.env
      })
    )
    if (answer.type === 'CREATED') {
      return
    }
    throw new Error('Terminal Host failed to start the terminal.')
  }

  write(sessionId: string, data: string): void {
    this.manager.notify(buildTerminalHostPayloadMessage('WRITE', { sessionId, data }))
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.manager.notify(buildTerminalHostPayloadMessage('RESIZE', { sessionId, cols, rows }))
  }

  async kill(sessionId: string): Promise<TerminalHostKillOutcome> {
    const requestId = randomUUID()
    let answer
    try {
      answer = await this.manager.request(buildTerminalHostPayloadMessage('KILL', { requestId, sessionId }))
    } catch {
      return 'failed'
    }
    if (answer.type === 'KILL_RESULT') {
      return answer.payload.outcome
    }
    return 'failed'
  }

  async shutdown(): Promise<void> {
    await this.manager.stop()
  }
}

/** Test stub: records calls, never touches processes. */
export function createStubTerminalHostClient(): TerminalHostClient & {
  readonly calls: Array<{ readonly op: string; readonly sessionId?: string }>
} {
  const calls: Array<{ readonly op: string; readonly sessionId?: string }> = []
  const client: TerminalHostClient & { readonly calls: Array<{ readonly op: string; readonly sessionId?: string }> } = {
    calls,
    create: () => {
      calls.push({ op: 'create' })
      return Promise.reject(new Error('Terminal Host stub does not spawn.'))
    },
    write: () => {},
    resize: () => {},
    kill: () => {
      calls.push({ op: 'kill' })
      return Promise.reject(new Error('Terminal Host stub does not kill.'))
    },
    shutdown: () => Promise.resolve(),
    onEvent: () => () => {}
  }
  return client
}
