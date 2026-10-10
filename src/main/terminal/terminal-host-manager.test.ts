import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildTerminalHostPayloadMessage } from './terminal-host-protocol'
import {
  TERMINAL_HOST_REQUEST_TIMEOUT_MS,
  TerminalHostManager,
  type TerminalHostLauncher,
  type TerminalHostProcess
} from './terminal-host-manager'

interface FakeChild extends TerminalHostProcess {
  posted: unknown[]
  kills: number
  fireMessage(message: unknown): void
  fireExit(): void
}

/** Fake utility-process child: no processes, fully scripted. */
function createFakeLauncher(children: FakeChild[]): TerminalHostLauncher {
  return {
    fork: () => {
      const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>()
      const child: FakeChild = {
        posted: [],
        kills: 0,
        fireMessage: (message: unknown) => {
          for (const listener of [...(listeners.get('message') ?? [])]) {
            listener(message)
          }
        },
        fireExit: () => {
          for (const listener of [...(listeners.get('exit') ?? [])]) {
            listener()
          }
        },
        postMessage: (message: unknown) => {
          child.posted.push(message)
        },
        kill: () => {
          child.kills += 1
          return true
        },
        on: (event, listener) => {
          const list = listeners.get(event) ?? []
          list.push(listener as (...args: Array<unknown>) => void)
          listeners.set(event, list)
        },
        removeAllListeners: (event) => {
          listeners.delete(event)
        }
      }
      children.push(child)
      return child
    }
  }
}

function readyMessage(): unknown {
  return { protocol: 'stark-terminal-host/v1', type: 'READY' }
}

function shutdownComplete(): unknown {
  return { protocol: 'stark-terminal-host/v1', type: 'SHUTDOWN_COMPLETE' }
}

async function startReady(dir: string, children: FakeChild[], options?: { startupTimeoutMs?: number }): Promise<TerminalHostManager> {
  const manager = new TerminalHostManager({
    bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
    userDataDir: dir,
    launcher: createFakeLauncher(children),
    ...options
  })
  const starting = manager.ensureReady()
  children[0]?.fireMessage(readyMessage())
  await starting
  return manager
}

/**
 * Terminal Host broker: process lifecycle with hard bounds, no
 * auto-restart, exact-owned kills, and correlated bounded requests.
 * All process behavior is faked; timing bounds use short injections.
 */
describe('terminal host manager', () => {
  it('starts on demand and reports ready exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      assert.equal(manager.getState(), 'ready')
      assert.equal(children.length, 1)
      await manager.ensureReady()
      assert.equal(children.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startup times out boundedly with no host left behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children),
        startupTimeoutMs: 30
      })
      await assert.rejects(manager.ensureReady(), /failed to start/)
      assert.equal(manager.getState(), 'crashed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unexpected exit becomes crashed with no restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      children[0]?.fireExit()
      assert.equal(manager.getState(), 'crashed')
      assert.equal(children.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop completes on SHUTDOWN_COMPLETE and on bare exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      const stopping = manager.stop()
      children[0]?.fireMessage(shutdownComplete())
      await stopping
      assert.equal(manager.getState(), 'stopped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop times out boundedly with exact-owned kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children),
        stopTimeoutMs: 30
      })
      const starting = manager.ensureReady()
      children[0]?.fireMessage(readyMessage())
      await starting
      assert.equal(manager.getState(), 'ready')
      // No SHUTDOWN_COMPLETE and no exit: the bound fires, the exact
      // child is killed, and stop still settles.
      await manager.stop()
      assert.equal(manager.getState(), 'stopped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('correlated requests resolve, time out, and fail on host exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      const pending = manager.request(
        buildTerminalHostPayloadMessage('KILL', { requestId: 'req-1', sessionId: 'sess-1' }),
        5000
      )
      children[0]?.fireMessage({
        protocol: 'stark-terminal-host/v1',
        type: 'KILL_RESULT',
        payload: { requestId: 'req-1', sessionId: 'sess-1', outcome: 'initiated' }
      })
      const answer = await pending
      assert.equal(answer.type, 'KILL_RESULT')
      await assert.rejects(
        manager.request(buildTerminalHostPayloadMessage('KILL', { requestId: 'req-2', sessionId: 'sess-2' }), 20),
        /timed out/
      )
      const doomed = manager.request(
        buildTerminalHostPayloadMessage('KILL', { requestId: 'req-3', sessionId: 'sess-3' }),
        5000
      )
      children[0]?.fireExit()
      await assert.rejects(doomed, /exited/)
      await manager.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('request and notify reject outside ready state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children)
      })
      await assert.rejects(
        manager.request(buildTerminalHostPayloadMessage('KILL', { requestId: 'r', sessionId: 's' })),
        /not ready/
      )
      assert.throws(() => manager.notify({ type: 'WRITE' }), /not ready/)
      assert.equal(TERMINAL_HOST_REQUEST_TIMEOUT_MS, 10_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop during startup settles every waiter instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children),
        startupTimeoutMs: 5000
      })
      // Two waiters, no READY: both must reject promptly on stop —
      // never linger on the abandoned starting promise.
      const first = manager.ensureReady()
      const second = manager.ensureReady()
      await manager.stop()
      assert.equal(manager.getState(), 'stopped')
      await assert.rejects(first, /stopped/)
      await assert.rejects(second, /stopped/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('child exit before READY rejects startup and marks crashed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children)
      })
      const starting = manager.ensureReady()
      children[0]?.fireExit()
      await assert.rejects(starting, /exited during startup/)
      assert.equal(manager.getState(), 'crashed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop terminates the exact host process on SHUTDOWN_COMPLETE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      const stopping = manager.stop()
      children[0]?.fireMessage(shutdownComplete())
      await stopping
      assert.equal(manager.getState(), 'stopped')
      // The host never self-exits: main must terminate exactly the
      // owned child or a live utility process lingers after stop.
      assert.equal(children[0]?.kills, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('host exit during stopping settles promptly, not via the stop bound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = new TerminalHostManager({
        bootstrapPath: join(dir, 'terminal-host-bootstrap.js'),
        userDataDir: dir,
        launcher: createFakeLauncher(children),
        stopTimeoutMs: 5000
      })
      const starting = manager.ensureReady()
      children[0]?.fireMessage(readyMessage())
      await starting
      const began = Date.now()
      const stopping = manager.stop()
      children[0]?.fireExit()
      await stopping
      assert.equal(manager.getState(), 'stopped')
      assert.ok(Date.now() - began < 1000, 'exit during stopping must settle at once')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('double stop settles both callers with one child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      const first = manager.stop()
      const second = manager.stop()
      children[0]?.fireMessage(shutdownComplete())
      await first
      await second
      assert.equal(manager.getState(), 'stopped')
      assert.equal(children.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a detached old host cannot satisfy new-generation requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      const oldChild = children[0] as FakeChild
      const stopping = manager.stop()
      oldChild.fireMessage(shutdownComplete())
      await stopping
      // New generation on a fresh child.
      const starting = manager.ensureReady()
      children[1]?.fireMessage(readyMessage())
      await starting
      assert.equal(children.length, 2)
      let resolved = false
      const pending = manager
        .request(buildTerminalHostPayloadMessage('KILL', { requestId: 'req-new', sessionId: 'sess-new' }), 5000)
        .then((answer) => {
          resolved = true
          return answer
        })
      // Late/stale answer from the OLD detached child: no listeners,
      // no correlation — the new request must stay pending.
      oldChild.fireMessage({
        protocol: 'stark-terminal-host/v1',
        type: 'KILL_RESULT',
        payload: { requestId: 'req-new', sessionId: 'sess-new', outcome: 'failed' }
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(resolved, false)
      // The live child answers normally.
      children[1]?.fireMessage({
        protocol: 'stark-terminal-host/v1',
        type: 'KILL_RESULT',
        payload: { requestId: 'req-new', sessionId: 'sess-new', outcome: 'gone' }
      })
      const answer = await pending
      assert.equal(answer.type, 'KILL_RESULT')
      await manager.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unknown request ids never resolve a waiter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-host-'))
    try {
      const children: FakeChild[] = []
      const manager = await startReady(dir, children)
      let resolved = false
      const pending = manager
        .request(buildTerminalHostPayloadMessage('KILL', { requestId: 'req-wanted', sessionId: 'sess-a' }), 5000)
        .then((answer) => {
          resolved = true
          return answer
        })
      children[0]?.fireMessage({
        protocol: 'stark-terminal-host/v1',
        type: 'KILL_RESULT',
        payload: { requestId: 'req-other', sessionId: 'sess-a', outcome: 'initiated' }
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(resolved, false)
      children[0]?.fireMessage({
        protocol: 'stark-terminal-host/v1',
        type: 'KILL_RESULT',
        payload: { requestId: 'req-wanted', sessionId: 'sess-a', outcome: 'initiated' }
      })
      const answer = await pending
      assert.equal(answer.type, 'KILL_RESULT')
      await manager.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
