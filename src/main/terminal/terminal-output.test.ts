import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal/types'
import { MAX_TERMINAL_OUTPUT_CHUNK_BYTES } from './limits'
import { splitOutputForIpc, type PtyFactory } from './pty-adapter'
import { TerminalManager } from './terminal-manager'

/**
 * Stage 11 output streaming: PTY bytes flow to the owning renderer in
 * bounded chunks with no unbounded main-process history buffer. ANSI
 * escapes and Unicode pass through as terminal data (xterm interprets
 * them); main never interprets markup.
 */
describe('terminal output streaming', () => {
  it('passes normal data through as a single event', () => {
    assert.deepEqual(splitOutputForIpc('hello\r\nworld', MAX_TERMINAL_OUTPUT_CHUNK_BYTES), ['hello\r\nworld'])
  })

  it('passes Unicode through untouched', () => {
    const value = 'héllo wörld ✓ 日本語 🎉'
    assert.deepEqual(splitOutputForIpc(value, MAX_TERMINAL_OUTPUT_CHUNK_BYTES), [value])
  })

  it('passes ANSI escapes as terminal data without interpretation', () => {
    const value = '\u001b[32mok\u001b[0m \u001b[1mbright\u001b[0m'
    assert.deepEqual(splitOutputForIpc(value, MAX_TERMINAL_OUTPUT_CHUNK_BYTES), [value])
  })

  it('splits oversized chunks into bounded payloads', () => {
    const big = 'x'.repeat(MAX_TERMINAL_OUTPUT_CHUNK_BYTES + 100)
    const chunks = splitOutputForIpc(big, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    assert.ok(chunks.length >= 2)
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    }
    assert.equal(chunks.join(''), big)
  })

  it('keeps multibyte characters intact across splits', () => {
    const big = 'é'.repeat(MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    const chunks = splitOutputForIpc(big, 64)
    assert.ok(chunks.length > 1)
    assert.equal(chunks.join(''), big)
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= 64)
    }
  })

  it('routes output only to the owning renderer in bounded chunks', () => {
    const seen: Array<{ owner: number; event: TerminalDataEvent }> = []
    const exits: TerminalExitEvent[] = []
    const hooks: { dataCb: ((data: string) => void) | null } = { dataCb: null }
    const factory: PtyFactory = {
      spawn: () => ({
        onData: (cb) => {
          hooks.dataCb = cb
        },
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {}
      })
    }
    const manager = new TerminalManager(factory, {
      sendData: (owner, event) => {
        seen.push({ owner, event })
      },
      sendExit: (_owner, event) => {
        exits.push(event)
      }
    })
    const session = manager.createSessionWithEnv({
      ownerWebContentsId: 501,
      workspaceId: 3,
      cwd: '/tmp',
      shellFile: 'sh',
      shellArgs: [],
      shellLabel: 'sh',
      cols: 80,
      rows: 24,
      env: {}
    })
    const big = 'y'.repeat(MAX_TERMINAL_OUTPUT_CHUNK_BYTES * 2 + 10)
    hooks.dataCb?.(big)
    assert.ok(seen.length >= 3)
    for (const entry of seen) {
      assert.equal(entry.owner, 501)
      assert.equal(entry.event.sessionId, session.id)
      assert.ok(Buffer.byteLength(entry.event.data, 'utf8') <= MAX_TERMINAL_OUTPUT_CHUNK_BYTES)
    }
    assert.equal(
      seen.map((entry) => entry.event.data).join(''),
      big
    )
    assert.equal(exits.length, 0)
  })

  it('holds no unbounded history buffer: late data after exit is dropped', () => {
    const seen: TerminalDataEvent[] = []
    const hooks: {
      dataCb: ((data: string) => void) | null
      exitCb: ((exit: { exitCode: number | null; signal: number | null }) => void) | null
    } = { dataCb: null, exitCb: null }
    const factory: PtyFactory = {
      spawn: () => ({
        onData: (cb) => {
          hooks.dataCb = cb
        },
        onExit: (cb) => {
          hooks.exitCb = cb
        },
        write: () => {},
        resize: () => {},
        kill: () => {}
      })
    }
    const manager = new TerminalManager(factory, {
      sendData: (_owner, event) => {
        seen.push(event)
      },
      sendExit: () => {}
    })
    manager.createSessionWithEnv({
      ownerWebContentsId: 502,
      workspaceId: 3,
      cwd: '/tmp',
      shellFile: 'sh',
      shellArgs: [],
      shellLabel: 'sh',
      cols: 80,
      rows: 24,
      env: {}
    })
    hooks.dataCb?.('before')
    hooks.exitCb?.({ exitCode: 0, signal: null })
    const countAfterExit = seen.length
    hooks.dataCb?.('after-exit-late')
    assert.equal(seen.length, countAfterExit)
  })
})
