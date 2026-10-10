import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'

const PROCESS_PATH = join(process.cwd(), 'src', 'main', 'extension-host', 'extension-process.mjs')

async function loadMjs<T>(absolutePath: string): Promise<T> {
  const { createRequire } = await import('node:module')
  return createRequire(__filename)(absolutePath) as T
}

type ProcessModule = {
  ExtensionProcessManager: new () => {
    spawnManaged: (args: { owner: string; extensionBase: string; command: string; argv?: string[] }) => {
      id: string
      alive: boolean
      kill: () => void
      onExit: (listener: (event: unknown) => void) => { dispose: () => void }
      stdoutTail: () => string
    }
    disposeOwner: (owner: string) => void
    listOwner: (owner: string) => { id: string; alive: boolean }[]
    countFor: (owner: string) => number
    __resetForTests: () => void
  }
  MAX_PROCESSES_PER_EXTENSION: number
  MAX_PROCESSES_TOTAL: number
  MAX_RESTARTS_PER_SLOT: number
}

describe('managed extension child processes', () => {
  it('spawns bare executables with exact ownership and sanitized env', async () => {
    const module = await loadMjs<ProcessModule>(PROCESS_PATH)
    const manager = new module.ExtensionProcessManager()
    try {
      assert.equal(module.MAX_PROCESSES_PER_EXTENSION, 4)
      assert.equal(module.MAX_PROCESSES_TOTAL, 64)
      assert.equal(module.MAX_RESTARTS_PER_SLOT, 3)
      const handle = manager.spawnManaged({
        owner: 'a.b@1.0.0',
        extensionBase: process.cwd(),
        command: 'node',
        argv: ['--version']
      })
      assert.equal(handle.alive, true)
      await new Promise((resolve) => {
        const subscription = handle.onExit(() => {
          subscription.dispose()
          resolve(undefined)
        })
      })
      assert.equal(handle.alive, false)
      assert.match(handle.stdoutTail(), /v\d+\./)
      assert.equal(manager.listOwner('a.b@1.0.0').length, 1)
      assert.equal(manager.listOwner('other.c@1.0.0').length, 0)
    } finally {
      manager.__resetForTests()
    }
  })

  it('rejects escapes, oversized argv, and per-extension caps', async () => {
    const module = await loadMjs<ProcessModule>(PROCESS_PATH)
    const manager = new module.ExtensionProcessManager()
    try {
      assert.throws(
        () => manager.spawnManaged({ owner: 'a.b@1.0.0', extensionBase: process.cwd(), command: '/bin/evil' }),
        /escapes|not valid/
      )
      assert.throws(
        () => manager.spawnManaged({ owner: 'a.b@1.0.0', extensionBase: process.cwd(), command: 'node', argv: ['x'.repeat(5000)] }),
        /not valid/
      )
      const handles = []
      for (let index = 0; index < 4; index += 1) {
        handles.push(manager.spawnManaged({ owner: 'cap.ext@1.0.0', extensionBase: process.cwd(), command: 'node', argv: ['--version'] }))
      }
      assert.throws(
        () => manager.spawnManaged({ owner: 'cap.ext@1.0.0', extensionBase: process.cwd(), command: 'node', argv: ['--version'] }),
        /Too many child processes/
      )
      for (const handle of handles) {
        handle.kill()
      }
    } finally {
      manager.__resetForTests()
    }
  })

  it('disposes only the owning extension (exact handles, no broad kills)', async () => {
    const module = await loadMjs<ProcessModule>(PROCESS_PATH)
    const manager = new module.ExtensionProcessManager()
    try {
      const first = manager.spawnManaged({ owner: 'a.one@1.0.0', extensionBase: process.cwd(), command: 'node', argv: ['--version'] })
      const second = manager.spawnManaged({ owner: 'b.two@1.0.0', extensionBase: process.cwd(), command: 'node', argv: ['--version'] })
      manager.disposeOwner('a.one@1.0.0')
      assert.equal(manager.listOwner('a.one@1.0.0').length, 0)
      assert.equal(manager.listOwner('b.two@1.0.0').length, 1)
      assert.equal(manager.countFor('b.two@1.0.0'), 1)
      second.kill()
      first.kill()
    } finally {
      manager.__resetForTests()
    }
  })
})
