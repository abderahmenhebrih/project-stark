import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal/types'
import { MAX_TERMINAL_INPUT_BYTES } from './limits'
import { TerminalManager, type TerminalEventSink } from './terminal-manager'
import type { PtyFactory, PtyHandle } from './pty-adapter'

/** Fake PTY: no native binary, fully synchronous hooks for tests. */
interface FakePty extends PtyHandle {
  written: string[]
  resized: Array<{ cols: number; rows: number }>
  kills: number
  fireData: (data: string) => void
  fireExit: (exitCode: number | null, signal: number | null) => void
}

function createFakeFactory(created: FakePty[]): PtyFactory {
  return {
    spawn: () => {
      let dataCb: ((data: string) => void) | null = null
      let exitCb: ((exit: { exitCode: number | null; signal: number | null }) => void) | null = null
      const fake: FakePty = {
        written: [],
        resized: [],
        kills: 0,
        onData: (cb) => {
          dataCb = cb
        },
        onExit: (cb) => {
          exitCb = cb
        },
        write: (data) => {
          fake.written.push(data)
        },
        resize: (cols, rows) => {
          fake.resized.push({ cols, rows })
        },
        kill: () => {
          fake.kills += 1
        },
        fireData: (data) => {
          dataCb?.(data)
        },
        fireExit: (exitCode, signal) => {
          exitCb?.({ exitCode, signal })
        }
      }
      created.push(fake)
      return fake
    }
  }
}

function createSink(data: TerminalDataEvent[], exits: TerminalExitEvent[]): TerminalEventSink {
  return {
    sendData: (_owner, event) => {
      data.push(event)
    },
    sendExit: (_owner, event) => {
      exits.push(event)
    }
  }
}

const BASE = {
  workspaceId: 7,
  cwd: '/tmp/stark-test',
  shellFile: 'powershell.exe',
  shellArgs: ['-NoLogo'] as const,
  shellLabel: 'PowerShell',
  cols: 80,
  rows: 24
}

/**
 * Stage 11 manager lifecycle with a fake PTY adapter: the native
 * node-pty binary is never required in ordinary node --test suites.
 */
describe('terminal manager', () => {
  it('creates a session with an opaque id and recorded owner', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 11, env: {} })
    assert.match(session.id, /^[0-9a-f-]{36}$/i)
    assert.equal(session.workspaceId, 7)
    assert.equal(session.running, true)
    assert.equal(created.length, 1)
  })

  it('one-session rule returns the existing active session without spawning', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const first = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 21, env: {} })
    const second = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 21, env: {} })
    assert.equal(second.id, first.id)
    assert.equal(created.length, 1)
  })

  it('write and resize delegate to the owned PTY', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 31, env: {} })
    manager.writeSession(31, session.id, 'echo hi\r')
    manager.resizeSession(31, session.id, 100, 30)
    assert.deepEqual(created[0]?.written, ['echo hi\r'])
    assert.deepEqual(created[0]?.resized, [{ cols: 100, rows: 30 }])
  })

  it('kill delegates and exit removes the session', () => {
    const data: TerminalDataEvent[] = []
    const exits: TerminalExitEvent[] = []
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink(data, exits))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 41, env: {} })
    manager.killSession(41, session.id)
    assert.equal(created[0]?.kills, 1)
    created[0]?.fireExit(0, null)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.sessionId, session.id)
    assert.throws(() => manager.writeSession(41, session.id, 'x'), /no longer available/)
  })

  it('wrong owner cannot write, resize, or kill', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 51, env: {} })
    assert.throws(() => manager.writeSession(52, session.id, 'x'), /no longer available/)
    assert.throws(() => manager.resizeSession(52, session.id, 80, 24), /no longer available/)
    assert.throws(() => manager.killSession(52, session.id), /no longer available/)
    assert.equal(created[0]?.written.length, 0)
    assert.equal(created[0]?.kills, 0)
  })

  it('unknown sessions and malformed ids are rejected', () => {
    const manager = new TerminalManager(createFakeFactory([]), createSink([], []))
    assert.throws(
      () => manager.writeSession(61, '00000000-0000-4000-8000-000000000000', 'x'),
      /no longer available/
    )
    assert.throws(() => manager.writeSession(61, 'not-a-session', 'x'), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(61, 'not-a-session', 80, 24), /not accepted|invalid/)
    assert.throws(() => manager.killSession(61, 'not-a-session'), /not accepted|invalid/)
  })

  it('rejects invalid dimensions and oversized input', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 71, env: {} })
    assert.throws(() => manager.resizeSession(71, session.id, 5, 24), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(71, session.id, 80, 1), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(71, session.id, 80.5, 24), /not accepted|invalid/)
    const huge = 'x'.repeat(MAX_TERMINAL_INPUT_BYTES + 1)
    assert.throws(() => manager.writeSession(71, session.id, huge), /too large|not accepted/)
    assert.throws(() => manager.writeSession(71, session.id, 42 as never), /must be a string|not accepted/)
  })

  it('webContents destruction cleans up without orphans', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 81, env: {} })
    manager.handleWebContentsDestroyed(81)
    assert.equal(created[0]?.kills, 1)
    assert.equal(manager.size, 0)
    assert.equal(manager.findActiveForOwner(81), undefined)
    assert.throws(() => manager.writeSession(81, session.id, 'x'), /no longer available/)
  })

  it('shutdownAll terminates every session boundedly', () => {
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], []))
    manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 91, env: {} })
    manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 92, env: {} })
    assert.equal(manager.size, 2)
    manager.shutdownAll()
    assert.equal(manager.size, 0)
    assert.equal(
      created.reduce((total, fake) => total + fake.kills, 0),
      2
    )
  })

  it('exit is delivered once even when fired twice', () => {
    const exits: TerminalExitEvent[] = []
    const created: FakePty[] = []
    const manager = new TerminalManager(createFakeFactory(created), createSink([], exits))
    const session = manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 101, env: {} })
    created[0]?.fireExit(1, null)
    created[0]?.fireExit(1, null)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.sessionId, session.id)
  })
})
