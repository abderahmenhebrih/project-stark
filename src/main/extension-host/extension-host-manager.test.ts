import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  EXTENSION_HOST_STARTUP_TIMEOUT_MS,
  EXTENSION_HOST_STOP_TIMEOUT_MS,
  ExtensionHostManager,
  type ExtensionHostForkOptions,
  type ExtensionHostProcess
} from './extension-host-manager'
import { EXTENSION_HOST_PROTOCOL } from './protocol'

class FakeHost implements ExtensionHostProcess {
  readonly posted: unknown[] = []
  killed = false
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly exitListeners = new Set<(code: number | null) => void>()

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  on(event: 'message' | 'exit', listener: (...args: Array<unknown>) => void): void {
    if (event === 'message') {
      this.messageListeners.add(listener as (message: unknown) => void)
    } else {
      this.exitListeners.add(listener as unknown as (code: number | null) => void)
    }
  }

  removeAllListeners(event: 'message' | 'exit'): void {
    if (event === 'message') {
      this.messageListeners.clear()
    } else {
      this.exitListeners.clear()
    }
  }

  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(message)
    }
  }

  emitExit(code: number | null = 1): void {
    for (const listener of [...this.exitListeners]) {
      listener(code)
    }
  }
}

interface ForkRecord {
  readonly modulePath: string
  readonly options: ExtensionHostForkOptions
  readonly host: FakeHost
}

function openManager(): {
  dir: string
  forks: ForkRecord[]
  manager: ExtensionHostManager
  logs: string[]
} {
  const dir = mkdtempSync(join(tmpdir(), 'stark-ext-host-'))
  const forks: ForkRecord[] = []
  const logs: string[] = []
  const manager = new ExtensionHostManager({
    bootstrapPath: join(dir, 'extension-host-bootstrap.js'),
    userDataDir: dir,
    launcher: {
      fork: (modulePath: string, options: ExtensionHostForkOptions) => {
        const host = new FakeHost()
        forks.push({ modulePath, options, host })
        return host
      }
    },
    startupTimeoutMs: 80,
    stopTimeoutMs: 50,
    onLog: (message: string) => {
      logs.push(message)
    }
  })
  return { dir, forks, manager, logs }
}

function readyEnvelope(type: string, extra: Record<string, unknown> = {}): unknown {
  return { protocol: EXTENSION_HOST_PROTOCOL, type, ...extra }
}

describe('extension host manager lifecycle', () => {
  it('starts in stopped state with spec bounds', () => {
    const { dir, manager } = openManager()
    try {
      assert.deepEqual(manager.getStatus(), { state: 'stopped' })
      assert.equal(EXTENSION_HOST_STARTUP_TIMEOUT_MS, 10_000)
      assert.equal(EXTENSION_HOST_STOP_TIMEOUT_MS, 5_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handshakes READY in an isolated context and ignores second starts', async () => {
    const { dir, forks, manager, logs } = openManager()
    try {
      process.env['STARK_TEST_CANARY_TOKEN_XYZ'] = 'canary-secret'
      const starting = manager.start()
      assert.equal(forks.length, 1)
      const second = await manager.start()
      assert.equal(second.state, 'starting')
      assert.equal(forks.length, 1)
      const record = forks[0]
      assert.ok(record !== undefined)
      assert.ok(record.modulePath.endsWith('extension-host-bootstrap.js'))
      assert.deepEqual(record.options.execArgv, [])
      assert.deepEqual(record.options.stdio, ['ignore', 'ignore', 'ignore'])
      assert.equal(record.options.cwd, join(dir, 'extension-host-runtime'))
      assert.ok(existsSync(join(dir, 'extension-host-runtime')))
      assert.ok(!('STARK_TEST_CANARY_TOKEN_XYZ' in record.options.env))
      record.host.emitMessage(readyEnvelope('READY'))
      const status = await starting
      assert.equal(status.state, 'ready')
      assert.equal(manager.getStatus().state, 'ready')
      assert.equal((await manager.start()).state, 'ready')
      assert.equal(forks.length, 1)
      assert.ok(logs.includes('extension-host: starting'))
      assert.ok(logs.includes('extension-host: ready'))
    } finally {
      delete process.env['STARK_TEST_CANARY_TOKEN_XYZ']
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startup timeout terminates the exact owned process as crashed', async () => {
    const { dir, forks, manager } = openManager()
    try {
      await assert.rejects(manager.start(), /failed to start/)
      assert.equal(manager.getStatus().state, 'crashed')
      assert.equal(forks.length, 1)
      assert.equal(forks[0]?.host.killed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unexpected exit during startup crashes without hanging', async () => {
    const { dir, forks, manager } = openManager()
    try {
      const starting = manager.start()
      assert.equal(forks.length, 1)
      forks[0]?.host.emitExit(1)
      await assert.rejects(starting)
      assert.equal(manager.getStatus().state, 'crashed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops gracefully on SHUTDOWN_COMPLETE', async () => {
    const { dir, forks, manager } = openManager()
    try {
      const starting = manager.start()
      forks[0]?.host.emitMessage(readyEnvelope('READY'))
      await starting
      const stopping = manager.stop()
      const posted = forks[0]?.host.posted ?? []
      assert.deepEqual(posted[posted.length - 1], { protocol: EXTENSION_HOST_PROTOCOL, type: 'SHUTDOWN' })
      forks[0]?.host.emitMessage(readyEnvelope('SHUTDOWN_COMPLETE'))
      assert.equal((await stopping).state, 'stopped')
      assert.equal(manager.getStatus().state, 'stopped')
      assert.equal(forks[0]?.host.killed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop timeout kills exactly the owned process and reports stopped', async () => {
    const { dir, forks, manager } = openManager()
    try {
      const starting = manager.start()
      forks[0]?.host.emitMessage(readyEnvelope('READY'))
      await starting
      const status = await manager.stop()
      assert.equal(status.state, 'stopped')
      assert.equal(forks[0]?.host.killed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stop while stopped is safe and stop-while-starting settles start', async () => {
    const { dir, forks, manager } = openManager()
    try {
      assert.equal((await manager.stop()).state, 'stopped')
      assert.equal(forks.length, 0)
      const starting = manager.start()
      assert.equal(forks.length, 1)
      const stopped = await manager.stop()
      assert.equal(stopped.state, 'stopped')
      assert.deepEqual(await starting, stopped)
      assert.equal(forks[0]?.host.killed, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('unexpected crash never restarts and allows manual start again', async () => {
    const { dir, forks, manager } = openManager()
    try {
      const starting = manager.start()
      forks[0]?.host.emitMessage(readyEnvelope('READY'))
      await starting
      forks[0]?.host.emitExit(1)
      assert.equal(manager.getStatus().state, 'crashed')
      assert.equal(forks.length, 1)
      const restarting = manager.start()
      assert.equal(forks.length, 2)
      forks[1]?.host.emitMessage(readyEnvelope('READY'))
      assert.equal((await restarting).state, 'ready')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores malformed, unknown, and oversized host messages', async () => {
    const { dir, forks, manager } = openManager()
    try {
      const starting = manager.start()
      const host = forks[0]?.host
      assert.ok(host !== undefined)
      for (const bad of [
        null,
        'READY',
        { protocol: EXTENSION_HOST_PROTOCOL },
        { protocol: EXTENSION_HOST_PROTOCOL, type: 'EXEC' },
        { protocol: EXTENSION_HOST_PROTOCOL, type: 'READY', blob: 'x'.repeat(70 * 1024) }
      ]) {
        host.emitMessage(bad)
      }
      assert.equal(manager.getStatus().state, 'starting')
      host.emitMessage(readyEnvelope('READY'))
      assert.equal((await starting).state, 'ready')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('extension host isolation', () => {
  it('production spawns a separate utility process running the shipped bootstrap', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    assert.ok(source.includes('utilityProcess.fork'), 'production must fork a dedicated utility process')
    assert.ok(source.includes('extension-host-bootstrap.js'), 'production must run the shipped bootstrap artifact')
    assert.ok(!source.includes('child_process'), 'host spawning must not use child_process')
    assert.ok(!source.includes('shell:true'), 'host spawning must not use shells')
  })

  it('hostile installed extensions stay completely inert across start and stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stark-ext-hostile-'))
    try {
      const evilDir = join(dir, 'extensions', 'evil.malware', '9.9.9', 'extension')
      mkdirSync(evilDir, { recursive: true })
      writeFileSync(
        join(dir, 'extensions', 'evil.malware', '9.9.9', 'stark-install.json'),
        JSON.stringify({ namespace: 'evil', name: 'malware', version: '9.9.9', source: 'open-vsx' })
      )
      writeFileSync(
        join(evilDir, 'package.json'),
        JSON.stringify({
          name: 'malware',
          publisher: 'evil',
          version: '9.9.9',
          main: './evil.js',
          activationEvents: ['*'],
          scripts: { postinstall: 'touch PWNED' }
        })
      )
      writeFileSync(
        join(evilDir, 'evil.js'),
        'require("node:fs").writeFileSync("PWNED", "x"); require("node:child_process").spawnSync("x");'
      )
      const forks: ForkRecord[] = []
      const manager = new ExtensionHostManager({
        bootstrapPath: join(dir, 'extension-host-bootstrap.js'),
        userDataDir: dir,
        launcher: {
          fork: (modulePath: string, options: ExtensionHostForkOptions) => {
            const host = new FakeHost()
            forks.push({ modulePath, options, host })
            return host
          }
        },
        startupTimeoutMs: 80,
        stopTimeoutMs: 50
      })
      const starting = manager.start()
      forks[0]?.host.emitMessage(readyEnvelope('READY'))
      await starting
      await manager.stop().then(
        () => {},
        () => {}
      )
      forks[0]?.host.emitMessage(readyEnvelope('SHUTDOWN_COMPLETE'))
      assert.ok(!existsSync(join(evilDir, 'PWNED')))
      assert.ok(!existsSync(join(dir, 'PWNED')))
      const posted = (forks[0]?.host.posted ?? []).map((message) => JSON.stringify(message))
      assert.ok(!posted.some((text) => text.includes('evil')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manager and bootstrap avoid execution primitives and extension paths', () => {
    const managerSource = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'extension-host-manager.ts'), 'utf8')
    for (const forbidden of ['taskkill', 'spawn(', 'exec(', 'shell:true', 'child_process', 'readdirSync', 'stark-install', '.vsix']) {
      assert.ok(!managerSource.includes(forbidden), `manager must not contain ${forbidden}`)
    }
    const bootstrap = readFileSync(join(process.cwd(), 'src', 'main', 'extension-host', 'bootstrap.js'), 'utf8')
    for (const forbidden of ['require(', 'import ', 'eval(', 'activationEvents', 'child_process', 'vscode']) {
      assert.ok(!bootstrap.includes(forbidden), `bootstrap must not contain ${forbidden}`)
    }
  })
})

describe('extension host formatter channel', () => {
  it('fans out messages and exits to subscribers and posts only when ready', async () => {
    const { dir, forks, manager } = openManager()
    try {
      assert.throws(() => manager.postToHost({ type: 'PING' }), /not ready/)
      const seen: unknown[] = []
      const unsubscribe = manager.onHostEvent((event) => {
        seen.push(event)
      })
      const starting = manager.start()
      const host = forks[0]?.host
      assert.ok(host !== undefined)
      host.emitMessage(readyEnvelope('READY'))
      await starting
      manager.postToHost({ protocol: EXTENSION_HOST_PROTOCOL, type: 'PING' })
      assert.equal(host.posted.length, 1)
      host.emitMessage(readyEnvelope('FORMATTER_READY', { payload: { activationId: 'a' } }))
      host.emitExit(1)
      assert.ok(seen.some((event) => (event as { kind: string }).kind === 'message'))
      assert.ok(seen.some((event) => (event as { kind: string }).kind === 'exit'))
      assert.equal(manager.getStatus().state, 'crashed')
      unsubscribe()
      assert.throws(() => manager.postToHost({ type: 'PING' }), /not ready/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('subscriber failures never break lifecycle control', async () => {
    const { dir, forks, manager } = openManager()
    try {
      manager.onHostEvent(() => {
        throw new Error('subscriber boom')
      })
      const starting = manager.start()
      forks[0]?.host.emitMessage(readyEnvelope('READY'))
      assert.equal((await starting).state, 'ready')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
