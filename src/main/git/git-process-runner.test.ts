import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { GitProcessRunner } from './git-process-runner'

interface CapturedOptions {
  command: string
  args: readonly string[]
  options: Record<string, unknown>
}

/** Minimal fake ChildProcess supporting the runner's surface only. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killCalled = 0

  kill(): boolean {
    this.killCalled += 1
    // Simulate process termination so the runner can settle.
    queueMicrotask(() => this.emit('close', null))
    return true
  }
}

function fakeSpawnFactory(behavior: (child: FakeChild, captured: CapturedOptions) => void): {
  spawn: (...args: unknown[]) => unknown
  captured: CapturedOptions[]
  children: FakeChild[]
} {
  const captured: CapturedOptions[] = []
  const children: FakeChild[] = []
  const spawn = (...args: unknown[]): unknown => {
    const [command, spawnArgs, options] = args as [string, readonly string[], Record<string, unknown>]
    const child = new FakeChild()
    captured.push({ command, args: spawnArgs, options })
    children.push(child)
    behavior(child, captured[captured.length - 1] as CapturedOptions)
    return child
  }
  return { spawn, captured, children }
}

describe('git process runner', () => {
  it('succeeds and returns structured exit info', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('git version 2.40.0\n'))
        child.emit('close', 0)
      })
    })
    const runner = new GitProcessRunner({
      spawnImpl: factory.spawn as never,
      timeoutMs: 5000
    })
    const result = await runner.runGit({ cwd: 'C:\\repo', args: ['--no-pager', '--version'], maxOutputBytes: 1024 })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.toString('utf8'), /git version/)
    assert.equal(factory.captured.length, 1)
  })

  it('reports nonzero exit without throwing', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from("fatal: not a git repository\n"))
        child.emit('close', 128)
      })
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    const result = await runner.runGit({ cwd: 'C:\\repo', args: ['--no-pager', 'rev-parse', '--show-toplevel'], maxOutputBytes: 1024 })
    assert.equal(result.exitCode, 128)
  })

  it('maps executable unavailable to GitUnavailableError with no raw ENOENT', async () => {
    const spawn = (): unknown => {
      const error = new Error("spawn git ENOENT") as Error & { code?: string }
      error.code = 'ENOENT'
      throw error
    }
    const runner = new GitProcessRunner({ spawnImpl: spawn as never })
    await assert.rejects(runner.runGit({ cwd: 'C:\\repo', args: ['--version'], maxOutputBytes: 1024 }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Git is not available on this system.')
      assert.ok(!error.message.includes('ENOENT'))
      return true
    })
  })

  it('times out, kills only that process, and rejects once', async () => {
    const factory = fakeSpawnFactory(() => {
      // Never closes: the runner timeout must fire.
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await assert.rejects(
      runner.runGit({ cwd: 'C:\\repo', args: ['status'], maxOutputBytes: 1024, timeoutMs: 30 }),
      /Git operation timed out\./
    )
    assert.equal(factory.children[0]?.killCalled, 1)
    assert.equal(factory.captured.length, 1)
  })

  it('rejects stdout overflow and kills the process', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(2048, 'x'))
      })
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await assert.rejects(
      runner.runGit({ cwd: 'C:\\repo', args: ['status'], maxOutputBytes: 1024, overflowKind: 'status', timeoutMs: 1000 }),
      /Git status is too large to display\./
    )
    assert.equal(factory.children[0]?.killCalled, 1)
  })

  it('rejects stderr overflow', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.alloc(2048, 'e'))
      })
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await assert.rejects(
      runner.runGit({ cwd: 'C:\\repo', args: ['status'], maxOutputBytes: 1024, timeoutMs: 1000 }),
      /Git status is too large to display\./
    )
  })

  it('rejects diff overflow with diff copy', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(2048, 'd'))
      })
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await assert.rejects(
      runner.runGit({ cwd: 'C:\\repo', args: ['diff'], maxOutputBytes: 1024, overflowKind: 'diff', timeoutMs: 1000 }),
      /This Git diff is too large to display\./
    )
  })

  it('kills the process on timeout (bounded cleanup)', async () => {
    const factory = fakeSpawnFactory(() => {})
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await assert.rejects(runner.runGit({ cwd: 'C:\\repo', args: ['status'], maxOutputBytes: 1024, timeoutMs: 20 }), /timed out/)
    assert.equal(factory.children[0]?.killCalled, 1)
  })

  it('makes exactly one attempt (no retry)', async () => {
    let calls = 0
    const spawn = (): unknown => {
      calls += 1
      const child = new FakeChild()
      queueMicrotask(() => child.emit('close', 1))
      return child
    }
    const runner = new GitProcessRunner({ spawnImpl: spawn as never })
    await runner.runGit({ cwd: 'C:\\repo', args: ['status'], maxOutputBytes: 1024 })
    assert.equal(calls, 1)
  })

  it('uses shell:false and ignores stdin', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => child.emit('close', 0))
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await runner.runGit({ cwd: 'C:\\repo', args: ['--version'], maxOutputBytes: 1024 })
    const options = factory.captured[0]?.options as Record<string, unknown>
    assert.equal(options['shell'], false)
    assert.deepEqual(options['stdio'], ['ignore', 'pipe', 'pipe'])
  })

  it('sets non-interactive environment without logging it', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => child.emit('close', 0))
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await runner.runGit({ cwd: 'C:\\repo', args: ['--version'], maxOutputBytes: 1024 })
    const options = factory.captured[0]?.options as Record<string, unknown>
    const env = options['env'] as Record<string, string>
    assert.equal(env['GIT_TERMINAL_PROMPT'], '0')
    assert.equal(env['GIT_PAGER'], 'cat')
    assert.equal(env['PAGER'], 'cat')
    assert.equal(env['GIT_OPTIONAL_LOCKS'], '0')
  })

  it('invokes only the git executable with argument arrays', async () => {
    const factory = fakeSpawnFactory((child) => {
      queueMicrotask(() => child.emit('close', 0))
    })
    const runner = new GitProcessRunner({ spawnImpl: factory.spawn as never })
    await runner.runGit({ cwd: 'C:\\repo', args: ['--no-pager', 'diff', '--', 'a/b.ts'], maxOutputBytes: 1024 })
    assert.equal(factory.captured[0]?.command, 'git')
    assert.ok(Array.isArray(factory.captured[0]?.args))
  })
})
