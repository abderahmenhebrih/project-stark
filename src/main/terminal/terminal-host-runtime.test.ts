import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const HOST_PATH = join(process.cwd(), 'src', 'main', 'terminal', 'terminal-host.mjs')

async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

interface HostPtyHandle {
  onData(callback: (data: string) => void): void
  onExit(callback: (exit: { exitCode: number | null; signal: number | null }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

type TerminalHostModule = {
  createTerminalHostRuntime: (deps: {
    spawnPty: (file: string, args: readonly string[], options: Record<string, unknown>) => HostPtyHandle
    send: (message: object) => void
    onMessage: (listener: (message: unknown) => void) => void
  }) => { readonly size: number }
}

/**
 * Terminal Host runtime: owns injected PTY handles behind the closed
 * protocol. No real processes here — the spawn function is faked;
 * real-ConPTY isolation is proven by the fork integration test.
 */

interface FakePty {
  written: string[]
  resized: Array<{ cols: number; rows: number }>
  kills: number
  fireData: (data: string) => void
  fireExit: (exitCode: number | null, signal: number | null) => void
}

function createSpawn(spawned: FakePty[], fail = false): (file: string, args: readonly string[], options: Record<string, unknown>) => HostPtyHandle {
  return () => {
    if (fail) {
      throw new Error('spawn unavailable')
    }
    let dataCb: ((data: string) => void) | null = null
    let exitCb: ((exit: { exitCode: number | null; signal: number | null }) => void) | null = null
    const fake: FakePty = {
      written: [],
      resized: [],
      kills: 0,
      fireData: (data: string) => dataCb?.(data),
      fireExit: (exitCode: number | null, signal: number | null) => exitCb?.({ exitCode, signal })
    }
    spawned.push(fake)
    return {
      onData: (cb: (data: string) => void) => {
        dataCb = cb
      },
      onExit: (cb: (exit: { exitCode: number | null; signal: number | null }) => void) => {
        exitCb = cb
      },
      write: (data: string) => {
        fake.written.push(data)
      },
      resize: (cols: number, rows: number) => {
        fake.resized.push({ cols, rows })
      },
      kill: () => {
        fake.kills += 1
      }
    }
  }
}

async function openHost(options?: { failSpawn?: boolean }): Promise<{
  sent: unknown[]
  receive: (message: unknown) => void
  spawned: FakePty[]
}> {
  const { createTerminalHostRuntime } = await loadMjs<TerminalHostModule>(HOST_PATH)
  const sent: unknown[] = []
  const spawned: FakePty[] = []
  let listener: ((message: unknown) => void) | null = null
  createTerminalHostRuntime({
    spawnPty: createSpawn(spawned, options?.failSpawn === true),
    send: (message: object) => {
      sent.push(message)
    },
    onMessage: (cb: (message: unknown) => void) => {
      listener = cb
    }
  })
  return {
    sent,
    receive: (message: unknown) => listener?.(message),
    spawned
  }
}

function byType(sent: unknown[], type: string): Array<Record<string, unknown>> {
  return sent.filter((entry) => (entry as Record<string, unknown>)['type'] === type) as Array<Record<string, unknown>>
}

const CREATE = {
  protocol: 'stark-terminal-host/v1',
  type: 'CREATE',
  payload: {
    requestId: 'req-1',
    sessionId: 'sess-1',
    cwd: 'C:\\work',
    shellFile: 'powershell.exe',
    shellArgs: ['-NoLogo'],
    cols: 80,
    rows: 24,
    env: {}
  }
}

describe('terminal host runtime', () => {
  it('announces READY on start', async () => {
    const { sent } = await openHost()
    assert.ok(sent.length >= 1)
    const first = sent[0] as Record<string, unknown>
    assert.equal(first['protocol'], 'stark-terminal-host/v1')
    assert.equal(first['type'], 'READY')
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost()
    receive(CREATE)
    assert.equal(spawned.length, 1)
    const created = byType(sent, 'CREATED')
    assert.equal(created.length, 1)
    assert.deepEqual((created[0] as Record<string, unknown>)['payload'], { requestId: 'req-1', sessionId: 'sess-1' })
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost()
    receive({ protocol: 'stark-terminal-host/v1', type: 'CREATE', payload: { requestId: 'r', sessionId: 's' } })
    receive({ protocol: 'wrong/v1', type: 'CREATE', payload: {} })
    receive({ type: 'SPAWN_ANYTHING' })
    receive(null)
    assert.equal(spawned.length, 0)
    assert.equal(byType(sent, 'CREATED').length, 0)
    const failed = byType(sent, 'CREATE_FAILED')
    assert.equal(failed.length, 1)
    assert.equal(((failed[0] as Record<string, unknown>)['payload'] as Record<string, unknown>)['code'], 'invalid')
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost({ failSpawn: true })
    receive(CREATE)
    assert.equal(spawned.length, 0)
    const failed = byType(sent, 'CREATE_FAILED')
    assert.equal(failed.length, 1)
    assert.equal(((failed[0] as Record<string, unknown>)['payload'] as Record<string, unknown>)['code'], 'spawn_failed')
  })

  it('', async () => {
    const { receive, spawned } = await openHost()
    receive(CREATE)
    receive({ protocol: 'stark-terminal-host/v1', type: 'WRITE', payload: { sessionId: 'sess-1', data: 'hi\r' } })
    receive({ protocol: 'stark-terminal-host/v1', type: 'RESIZE', payload: { sessionId: 'sess-1', cols: 100, rows: 30 } })
    receive({ protocol: 'stark-terminal-host/v1', type: 'WRITE', payload: { sessionId: 'nope', data: 'hi\r' } })
    assert.deepEqual(spawned[0]?.written, ['hi\r'])
    assert.deepEqual(spawned[0]?.resized, [{ cols: 100, rows: 30 }])
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost()
    receive(CREATE)
    spawned[0]?.fireData('out-1')
    spawned[0]?.fireData('out-2')
    const data = byType(sent, 'DATA')
    assert.equal(data.length, 2)
    assert.deepEqual(
      data.map((entry) => (entry['payload'] as Record<string, unknown>)['data']),
      ['out-1', 'out-2']
    )
    spawned[0]?.fireExit(0, null)
    spawned[0]?.fireExit(0, null)
    const exits = byType(sent, 'EXIT')
    assert.equal(exits.length, 1)
    // Post-exit output is dropped (session forgotten).
    spawned[0]?.fireData('late')
    assert.equal(byType(sent, 'DATA').length, 2)
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost()
    const kill = (requestId: string, sessionId: string): void => {
      receive({ protocol: 'stark-terminal-host/v1', type: 'KILL', payload: { requestId, sessionId } })
    }
    kill('req-gone', 'missing')
    receive(CREATE)
    kill('req-kill', 'sess-1')
    assert.equal(spawned[0]?.kills, 1)
    const results = byType(sent, 'KILL_RESULT')
    assert.deepEqual(
      results.map((entry) => entry['payload']),
      [
        { requestId: 'req-gone', sessionId: 'missing', outcome: 'gone' },
        { requestId: 'req-kill', sessionId: 'sess-1', outcome: 'initiated' }
      ]
    )
  })

  it('', async () => {
    const { sent, receive, spawned } = await openHost()
    receive(CREATE)
    receive({ protocol: 'stark-terminal-host/v1', type: 'SHUTDOWN', payload: undefined })
    assert.equal(spawned[0]?.kills, 1)
    assert.equal(byType(sent, 'SHUTDOWN_COMPLETE').length, 1)
  })
})
