import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal/types'
import { MAX_HUMAN_TERMINALS, MAX_TERMINAL_INPUT_BYTES } from './limits'
import { createFakeTerminalHostClient, type FakeTerminalHost } from './terminal-host-fake'
import { TerminalManager, type TerminalEventSink } from './terminal-manager'

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

function openStack(options?: { failCreate?: boolean; killOutcome?: 'initiated' | 'gone' | 'failed'; deferKill?: boolean }): {
  manager: TerminalManager
  host: FakeTerminalHost
  data: TerminalDataEvent[]
  exits: TerminalExitEvent[]
} {
  const data: TerminalDataEvent[] = []
  const exits: TerminalExitEvent[] = []
  const host = createFakeTerminalHostClient(options)
  const manager = new TerminalManager(host, createSink(data, exits))
  return { manager, host, data, exits }
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
 * Broker lifecycle with a fake Terminal Host: no native binary, no
 * processes — the host client is fully synchronous unless a test
 * opts into deferred answers. Main owns policy; the fake owns nothing.
 */
describe('terminal manager', () => {
  it('creates a session with an opaque id and recorded owner', async () => {
    const { manager, host } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 11, env: {} })
    assert.match(session.id, /^[0-9a-f-]{36}$/i)
    assert.equal(session.workspaceId, 7)
    assert.equal(session.running, true)
    assert.equal(host.created.length, 1)
    assert.equal(host.created[0]?.sessionId, session.id)
    assert.equal(host.created[0]?.shellFile, 'powershell.exe')
    assert.equal(host.created[0]?.cwd, '/tmp/stark-test')
  })

  it('creates independent sessions per request without replacing running ones', async () => {
    const { manager, host } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 21, env: {} })
    const second = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 21, env: {} })
    assert.notEqual(second.id, first.id)
    assert.equal(host.created.length, 2)
    assert.equal(manager.size, 2)
    assert.equal(manager.liveCountForOwner(21), 2)
  })

  it('enforces the per-owner terminal cap without evicting', async () => {
    const { manager, host } = openStack()
    const ids: string[] = []
    for (let index = 0; index < MAX_HUMAN_TERMINALS; index += 1) {
      ids.push((await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 22, env: {} })).id)
    }
    assert.equal(host.created.length, MAX_HUMAN_TERMINALS)
    await assert.rejects(
      manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 22, env: {} }),
      /Too many terminals are open\. Close one before creating another\./
    )
    assert.equal(host.created.length, MAX_HUMAN_TERMINALS)
    assert.equal(manager.size, MAX_HUMAN_TERMINALS)
    // Other owners are unaffected by one owner's cap.
    const other = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 23, env: {} })
    assert.ok(other.id.length > 0)
    assert.equal(host.created.length, MAX_HUMAN_TERMINALS + 1)
  })

  it('a freed slot permits another terminal to start', async () => {
    const { manager, host } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 24, env: {} })
    for (let index = 1; index < MAX_HUMAN_TERMINALS; index += 1) {
      await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 24, env: {} })
    }
    await manager.killSession(24, first.id)
    host.fireExit(first.id, 0, null)
    const next = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 24, env: {} })
    assert.ok(next.id.length > 0)
    assert.equal(manager.size, MAX_HUMAN_TERMINALS)
  })

  it('write and resize delegate to the owned host session', async () => {
    const { manager, host } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 31, env: {} })
    manager.writeSession(31, session.id, 'echo hi\r')
    manager.resizeSession(31, session.id, 100, 30)
    assert.deepEqual(host.sessions.get(session.id)?.written, ['echo hi\r'])
    assert.deepEqual(host.sessions.get(session.id)?.resized, [{ cols: 100, rows: 30 }])
  })

  it('kill initiates promptly and tracks the session until a delayed exit', async () => {
    // A ConPTY teardown may take a while to emit exit: killSession
    // issues the exact kill and returns without waiting, keeps
    // ownership bookkeeping meanwhile, and finalizes on exit.
    const { manager, host, exits } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 85, env: {} })
    const second = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 85, env: {} })
    await manager.killSession(85, first.id)
    assert.equal(host.sessions.get(first.id)?.kills, 1)
    assert.equal(host.sessions.get(second.id)?.kills ?? 0, 0)
    // Ownership retained while the exit is still in flight: the
    // closing session rejects writes, the sibling keeps working.
    assert.equal(manager.size, 2)
    assert.throws(() => manager.writeSession(85, first.id, 'x'), /no longer available/)
    manager.writeSession(85, second.id, 'alive\r')
    assert.deepEqual(host.sessions.get(second.id)?.written, ['alive\r'])
    // Delayed exit arrives much later: delivered once, then removed.
    host.fireExit(first.id, 0, null)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.sessionId, first.id)
    assert.equal(manager.size, 1)
    assert.equal(manager.liveCountForOwner(85), 1)
  })

  it('kill outcome gone removes the session and reports NotFound', async () => {
    const { manager } = openStack({ killOutcome: 'gone' })
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 86, env: {} })
    await assert.rejects(manager.killSession(86, session.id), /no longer available/)
    assert.equal(manager.size, 0)
  })

  it('kill outcome failed keeps the live session for safe recovery', async () => {
    const { manager, host } = openStack({ killOutcome: 'failed' })
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 87, env: {} })
    await assert.rejects(manager.killSession(87, session.id), /We couldn’t close the terminal\./)
    // The terminal may still be alive: it stays tracked and reachable
    // so the renderer can restore (not strand) it.
    assert.equal(manager.size, 1)
    assert.equal(manager.liveCountForOwner(87), 1)
    assert.equal(host.sessions.get(session.id)?.kills, 1)
  })

  it('deferred host kill never blocks sibling operations', async () => {
    const { manager, host } = openStack({ deferKill: true })
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 88, env: {} })
    const second = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 88, env: {} })
    const killing = manager.killSession(88, first.id)
    // While the kill answer is still withheld, the broker keeps
    // serving every other session without waiting.
    manager.writeSession(88, second.id, 'still responsive\r')
    assert.deepEqual(host.sessions.get(second.id)?.written, ['still responsive\r'])
    host.releaseKill()
    await killing
    assert.equal(host.sessions.get(first.id)?.kills, 1)
  })

  it('wrong owner cannot write, resize, or kill', async () => {
    const { manager, host } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 51, env: {} })
    assert.throws(() => manager.writeSession(52, session.id, 'x'), /no longer available/)
    assert.throws(() => manager.resizeSession(52, session.id, 80, 24), /no longer available/)
    await assert.rejects(manager.killSession(52, session.id), /no longer available/)
    assert.equal(host.sessions.get(session.id)?.written.length ?? 0, 0)
    assert.equal(host.sessions.get(session.id)?.kills ?? 0, 0)
  })

  it('unknown sessions and malformed ids are rejected', async () => {
    const { manager } = openStack()
    assert.throws(
      () => manager.writeSession(61, '00000000-0000-4000-8000-000000000000', 'x'),
      /no longer available/
    )
    assert.throws(() => manager.writeSession(61, 'not-a-session', 'x'), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(61, 'not-a-session', 80, 24), /not accepted|invalid/)
    await assert.rejects(manager.killSession(61, 'not-a-session'), /not accepted|invalid/)
  })

  it('rejects invalid dimensions and oversized input', async () => {
    const { manager } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 71, env: {} })
    assert.throws(() => manager.resizeSession(71, session.id, 5, 24), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(71, session.id, 80, 1), /not accepted|invalid/)
    assert.throws(() => manager.resizeSession(71, session.id, 80.5, 24), /not accepted|invalid/)
    const huge = 'x'.repeat(MAX_TERMINAL_INPUT_BYTES + 1)
    assert.throws(() => manager.writeSession(71, session.id, huge), /too large|not accepted/)
    assert.throws(() => manager.writeSession(71, session.id, 42 as never), /must be a string|not accepted/)
  })

  it('create failure tracks nothing and reports safe copy', async () => {
    const { manager } = openStack({ failCreate: true })
    await assert.rejects(manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 72, env: {} }), /We couldn’t start the terminal\./)
    assert.equal(manager.size, 0)
    assert.equal(manager.findActiveForOwner(72), undefined)
  })

  it('webContents destruction cleans up without orphans', async () => {
    const { manager, host } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 81, env: {} })
    manager.handleWebContentsDestroyed(81)
    assert.equal(host.sessions.get(session.id)?.kills, 1)
    assert.equal(manager.size, 0)
    assert.equal(manager.findActiveForOwner(81), undefined)
    assert.throws(() => manager.writeSession(81, session.id, 'x'), /no longer available/)
  })

  it('destroying one owner kills every owned session and nothing else', async () => {
    const { manager, host } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 82, env: {} })
    const second = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 82, env: {} })
    const other = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 83, env: {} })
    manager.handleWebContentsDestroyed(82)
    assert.equal(host.sessions.get(first.id)?.kills, 1)
    assert.equal(host.sessions.get(second.id)?.kills, 1)
    assert.equal(host.sessions.get(other.id)?.kills ?? 0, 0)
    assert.equal(manager.size, 1)
    assert.throws(() => manager.writeSession(82, first.id, 'x'), /no longer available/)
    assert.throws(() => manager.writeSession(82, second.id, 'x'), /no longer available/)
    manager.writeSession(83, other.id, 'x')
    assert.deepEqual(host.sessions.get(other.id)?.written, ['x'])
  })

  it('killing one session leaves its siblings running', async () => {
    const { manager, host, exits } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 84, env: {} })
    const second = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 84, env: {} })
    await manager.killSession(84, first.id)
    host.fireExit(first.id, 0, null)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.sessionId, first.id)
    manager.writeSession(84, second.id, 'still here\r')
    assert.deepEqual(host.sessions.get(second.id)?.written, ['still here\r'])
    assert.equal(host.sessions.get(second.id)?.kills ?? 0, 0)
  })

  it('host crash marks every session exited honestly without restarting', async () => {
    const { manager, host, exits } = openStack()
    const first = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 89, env: {} })
    await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 89, env: {} })
    host.fireHostDown()
    assert.equal(manager.size, 0)
    assert.equal(exits.length, 2)
    assert.ok(exits.every((exit) => exit.exitCode === null))
    assert.throws(() => manager.writeSession(89, first.id, 'x'), /no longer available/)
    assert.equal(host.shutdowns, 0)
  })

  it('shutdownAll stops the host and clears bookkeeping', async () => {
    const { manager, host } = openStack()
    await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 91, env: {} })
    await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 92, env: {} })
    assert.equal(manager.size, 2)
    await manager.shutdownAll()
    assert.equal(host.shutdowns, 1)
    assert.equal(manager.size, 0)
  })

  it('exit is delivered once even when fired twice', async () => {
    const { manager, host, exits } = openStack()
    const session = await manager.createSessionWithEnv({ ...BASE, ownerWebContentsId: 101, env: {} })
    host.fireExit(session.id, 1, null)
    host.fireExit(session.id, 1, null)
    assert.equal(exits.length, 1)
    assert.equal(exits[0]?.sessionId, session.id)
  })
})
