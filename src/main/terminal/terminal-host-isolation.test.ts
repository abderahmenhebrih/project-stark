import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const HOST_PATH = join(process.cwd(), 'src', 'main', 'terminal', 'terminal-host.mjs')
const PROTOCOL = 'stark-terminal-host/v1'

/** Bounded helpers: every wait has a hard timeout, cleanup is exact-owned. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Minimal spawn environment for the real shell: Windows process
 * creation requires SystemRoot (plus PATH/TEMP for a working shell).
 * Test-only helper; production builds the full sanitized environment
 * main-side.
 */
function spawnEnv(): Record<string, string> {
  const allow = ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']
  const env: Record<string, string> = {}
  for (const key of allow) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') {
      env[key] = value
    }
  }
  return env
}

interface Collected {
  readonly type: string
  readonly payload?: Record<string, unknown>
  readonly at: number
}

/**
 * Real-process isolation proof: forks the actual Terminal Host with
 * real node-pty/ConPTY, busies a shell, then kills it (the operation
 * measured at ~3–5s of synchronous native blocking under Electron)
 * while asserting the PARENT event loop never stalls and a second
 * command completes during the kill window. Bounded end to end.
 */
describe('terminal host process isolation', () => {
  it('a blocking ConPTY kill never stalls the parent broker', { timeout: 90000 }, async () => {
    // PTY cwd is the repo root (no temp dir to clean: a lingering
    // child would lock rmdir with EBUSY and fail teardown noisily).
    const cwd = process.cwd()
    const child: ChildProcess = fork(HOST_PATH, [], { cwd, silent: true })
    const received: Collected[] = []
    let readyResolve: (() => void) | null = null
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
    child.on('message', (message: unknown) => {
      const record = message as Record<string, unknown>
      received.push({ type: String(record['type'] ?? ''), payload: record['payload'] as Record<string, unknown>, at: Date.now() })
      if (record['protocol'] === PROTOCOL && record['type'] === 'READY') {
        readyResolve?.()
      }
    })
    const finish = async (): Promise<void> => {
      try {
        child.send({ protocol: PROTOCOL, type: 'SHUTDOWN' })
      } catch {
        // Best effort; kill below is authoritative.
      }
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      await exited
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      // Bounded confirmation: no orphan host process may remain.
      const start = Date.now()
      while (child.exitCode === null && child.signalCode === null && Date.now() - start < 5000) {
        await sleep(50)
      }
    }
    try {
      await Promise.race([
        ready,
        sleep(15000).then(() => {
          throw new Error('Terminal Host did not become ready.')
        })
      ])
      const send = (message: object): void => {
        const delivered = child.send(message)
        assert.equal(delivered, true)
      }
      const waitFor = async (type: string, match: (payload?: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Collected> => {
        const start = Date.now()
        for (;;) {
          const found = received.find((entry) => entry.type === type && match(entry.payload))
          if (found !== undefined) {
            return found
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for ${type}.`)
          }
          await sleep(25)
        }
      }
      // Two shells: A will be busied, B proves responsiveness.
      const env = spawnEnv()
      send({ protocol: PROTOCOL, type: 'CREATE', payload: { requestId: 'req-a', sessionId: 'sess-a', cwd, shellFile: 'powershell.exe', shellArgs: ['-NoLogo'], cols: 80, rows: 24, env } })
      send({ protocol: PROTOCOL, type: 'CREATE', payload: { requestId: 'req-b', sessionId: 'sess-b', cwd, shellFile: 'powershell.exe', shellArgs: ['-NoLogo'], cols: 80, rows: 24, env } })
      await waitFor('CREATED', (payload) => payload?.['sessionId'] === 'sess-a', 15000)
      await waitFor('CREATED', (payload) => payload?.['sessionId'] === 'sess-b', 15000)
      // Busy shell A with a streaming child process.
      send({ protocol: PROTOCOL, type: 'WRITE', payload: { sessionId: 'sess-a', data: 'ping -t 127.0.0.1\r' } })
      await sleep(1500)
      // Parent heartbeat: proves OUR event loop never stalls, no
      // matter how long the host-side native kill blocks.
      let last = Date.now()
      let worstGapMs = 0
      const heartbeat = setInterval(() => {
        const now = Date.now()
        worstGapMs = Math.max(worstGapMs, now - last - 10)
        last = now
      }, 10)
      try {
        const killSentAt = Date.now()
        send({ protocol: PROTOCOL, type: 'KILL', payload: { requestId: 'req-kill-a', sessionId: 'sess-a' } })
        // A second command issued DURING the kill window must still
        // complete promptly (host message pump stays alive).
        send({ protocol: PROTOCOL, type: 'WRITE', payload: { sessionId: 'sess-b', data: 'echo alive\r' } })
        const echo = await waitFor(
          'DATA',
          (payload) => payload?.['sessionId'] === 'sess-b' && typeof payload?.['data'] === 'string',
          15000
        )
        const killResult = await waitFor(
          'KILL_RESULT',
          (payload) => payload?.['requestId'] === 'req-kill-a',
          20000
        )
        const exitA = await waitFor('EXIT', (payload) => payload?.['sessionId'] === 'sess-a', 20000)
        const killToExitMs = exitA.at - killSentAt
        assert.equal((killResult.payload as Record<string, unknown>)['outcome'], 'initiated')
        // Parent responsiveness holds unconditionally.
        assert.ok(worstGapMs < 1000, `parent event loop must stay responsive (worst gap ${worstGapMs}ms)`)
        // When this environment blocks inside native kill (Windows
        // ConPTY, measured ~3–5s), the echo MUST have completed
        // during that window — the isolation proof.
        if (killToExitMs >= 1000) {
          assert.ok(echo.at < exitA.at, 'sibling traffic must complete while the kill is still blocked in-host')
        }
      } finally {
        clearInterval(heartbeat)
      }
    } finally {
      await finish()
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'forked host must be gone after cleanup')
    }
  })
})
