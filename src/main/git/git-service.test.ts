import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { GitService, type GitRunnerLike } from './git-service'

function openWorkspaces(): { db: DatabaseSync; workspaces: WorkspaceRepository; dir: string; root: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const dir = mkdtempSync(join(tmpdir(), 'stark-git-svc-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  return { db, workspaces: new WorkspaceRepository(db), dir, root }
}

async function createWorkspace(workspaces: WorkspaceRepository, root: string): Promise<number> {
  const now = Date.now()
  const created = workspaces.create({ rootPath: root, displayName: 'project', now })
  return created.id
}

interface FakeResult {
  exitCode: number
  stdout: string
  stderr: string
}

function fakeRunner(handler: (args: readonly string[], cwd: string) => FakeResult): GitRunnerLike & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runGit: (options: { args: readonly string[]; cwd: string }): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> => {
      calls.push([...options.args])
      const result = handler(options.args, options.cwd)
      return Promise.resolve({
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdout, 'utf8'),
        stderr: Buffer.from(result.stderr, 'utf8')
      })
    }
  }
}

function readyHandler(root: string): (args: readonly string[], cwd: string) => FakeResult {
  return (args) => {
    const joined = args.join(' ')
    if (joined.includes('--version')) {
      return { exitCode: 0, stdout: 'git version 2.40.0\n', stderr: '' }
    }
    if (joined.includes('--show-toplevel')) {
      return { exitCode: 0, stdout: `${root}\n`, stderr: '' }
    }
    if (joined.includes('--is-bare-repository')) {
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }
    if (joined.includes('--is-inside-work-tree')) {
      return { exitCode: 0, stdout: 'true\n', stderr: '' }
    }
    if (joined.includes('symbolic-ref')) {
      return { exitCode: 0, stdout: 'main\n', stderr: '' }
    }
    if (joined.includes('rev-parse') && joined.includes('--short=12')) {
      return { exitCode: 0, stdout: 'abc123def456\n', stderr: '' }
    }
    if (joined.includes('@{upstream}')) {
      if (joined.includes('rev-list')) {
        return { exitCode: 0, stdout: '2\t1\n', stderr: '' }
      }
      return { exitCode: 0, stdout: 'origin/main\n', stderr: '' }
    }
    if (joined.includes('status')) {
      return { exitCode: 0, stdout: 'M  staged.ts\0 M working.ts\0', stderr: '' }
    }
    if (joined.includes('diff')) {
      return { exitCode: 0, stdout: 'diff --git a/staged.ts b/staged.ts\n', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

describe('git service (fake runner)', () => {
  it('returns unavailable when git is missing', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner(() => {
        throw new Error('unavailable')
      })
      // Simulate ENOENT-style unavailability: version fails with exit != 0
      // is treated as available=false only when runner throws GitUnavailable;
      // here force the service cache path via a runner that throws it.
      const { GitUnavailableError } = await import('./errors')
      const failing: GitRunnerLike = {
        runGit: () => Promise.reject(new GitUnavailableError())
      }
      const service = new GitService(fixture.workspaces, failing)
      const state = await service.getStatus({ workspaceId: id })
      assert.equal(state.kind, 'unavailable')
      assert.equal(runner.calls.length, 0)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('returns not-repository when top-level fails', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner((args) => {
        const joined = args.join(' ')
        if (joined.includes('--version')) {
          return { exitCode: 0, stdout: 'git version 2.40.0\n', stderr: '' }
        }
        return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
      })
      const service = new GitService(fixture.workspaces, runner)
      const state = await service.getStatus({ workspaceId: id })
      assert.equal(state.kind, 'not-repository')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('refuses parent repo when top-level != workspace root', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner((args) => {
        const joined = args.join(' ')
        if (joined.includes('--version')) {
          return { exitCode: 0, stdout: 'git version 2.40.0\n', stderr: '' }
        }
        if (joined.includes('--show-toplevel')) {
          return { exitCode: 0, stdout: `${join(fixture.dir, 'parent')}\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      })
      const service = new GitService(fixture.workspaces, runner)
      const state = await service.getStatus({ workspaceId: id })
      assert.equal(state.kind, 'root-mismatch')
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('returns ready branch/clean/dirty state', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner(readyHandler(fixture.root))
      const service = new GitService(fixture.workspaces, runner)
      const state = await service.getStatus({ workspaceId: id })
      assert.equal(state.kind, 'ready')
      if (state.kind === 'ready') {
        assert.equal(state.workspaceId, id)
        assert.equal(state.clean, false)
        assert.equal(state.branch.kind, 'branch')
        assert.equal(state.branch.name, 'main')
        assert.equal(state.branch.upstream, 'origin/main')
        assert.equal(state.branch.ahead, 2)
        assert.equal(state.branch.behind, 1)
        assert.equal(state.files.length, 2)
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('returns clean when status is empty', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const base = readyHandler(fixture.root)
      const runner = fakeRunner((args, cwd) => {
        if (args.join(' ').includes('status')) {
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return base(args, cwd)
      })
      const service = new GitService(fixture.workspaces, runner)
      const state = await service.getStatus({ workspaceId: id })
      assert.equal(state.kind, 'ready')
      if (state.kind === 'ready') {
        assert.equal(state.clean, true)
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('serves staged diff with fixed safe args', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner(readyHandler(fixture.root))
      const service = new GitService(fixture.workspaces, runner)
      const result = await service.getDiff({ workspaceId: id, relativePath: 'staged.ts', target: 'staged' })
      assert.equal(result.relativePath, 'staged.ts')
      assert.equal(result.target, 'staged')
      assert.ok(result.patch.includes('diff --git'))
      const diffCall = runner.calls.find((args) => args.includes('diff') && args.includes('--cached'))
      assert.ok(diffCall !== undefined)
      assert.ok(diffCall.includes('--no-ext-diff'))
      assert.ok(diffCall.includes('--no-textconv'))
      assert.ok(diffCall.includes('--no-color'))
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('serves unstaged diff', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const base = readyHandler(fixture.root)
      const runner = fakeRunner((args, cwd) => {
        if (args.join(' ').includes('status')) {
          return { exitCode: 0, stdout: ' M working.ts\0', stderr: '' }
        }
        if (args.includes('diff')) {
          return { exitCode: 0, stdout: 'diff --git a/working.ts b/working.ts\n', stderr: '' }
        }
        return base(args, cwd)
      })
      const service = new GitService(fixture.workspaces, runner)
      const result = await service.getDiff({ workspaceId: id, relativePath: 'working.ts', target: 'unstaged' })
      assert.equal(result.target, 'unstaged')
      const diffCall = runner.calls.find((args) => args.includes('diff'))
      assert.ok(diffCall !== undefined && !diffCall.includes('--cached'))
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('refuses untracked diff without inventing a patch', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const base = readyHandler(fixture.root)
      const runner = fakeRunner((args, cwd) => {
        if (args.join(' ').includes('status')) {
          return { exitCode: 0, stdout: '?? new.txt\0', stderr: '' }
        }
        return base(args, cwd)
      })
      const service = new GitService(fixture.workspaces, runner)
      await assert.rejects(service.getDiff({ workspaceId: id, relativePath: 'new.txt', target: 'unstaged' }), /untracked/)
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('enforces status membership (no invented pathspecs)', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner(readyHandler(fixture.root))
      const service = new GitService(fixture.workspaces, runner)
      await assert.rejects(
        service.getDiff({ workspaceId: id, relativePath: 'invented/evil.txt', target: 'staged' }),
        /We couldn’t read this Git diff\./
      )
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps safe.directory without mutating config', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const runner = fakeRunner((args) => {
        if (args.join(' ').includes('--version')) {
          return { exitCode: 0, stdout: 'git version 2.40.0\n', stderr: '' }
        }
        return { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership in repository; add safe.directory\n' }
      })
      const service = new GitService(fixture.workspaces, runner)
      await assert.rejects(service.getStatus({ workspaceId: id }), /ownership\/safety/)
      // No safe.directory mutation: no config command was ever issued.
      for (const call of runner.calls) {
        assert.ok(!call.includes('config'), 'must never run git config')
      }
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps diff too-large without raw errors', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const { GitDiffTooLargeError } = await import('./errors')
      const base = readyHandler(fixture.root)
      const runner: GitRunnerLike = {
        runGit: (options: { args: readonly string[]; cwd: string }) => {
          if (options.args.join(' ').includes('diff')) {
            return Promise.reject(new GitDiffTooLargeError())
          }
          const result = base(options.args, options.cwd)
          return Promise.resolve({
            exitCode: result.exitCode,
            stdout: Buffer.from(result.stdout, 'utf8'),
            stderr: Buffer.from(result.stderr, 'utf8')
          })
        }
      }
      const service = new GitService(fixture.workspaces, runner)
      await assert.rejects(
        service.getDiff({ workspaceId: id, relativePath: 'staged.ts', target: 'staged' }),
        /This Git diff is too large to display\./
      )
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('maps timeout without raw errors', async () => {
    const fixture = openWorkspaces()
    try {
      const id = await createWorkspace(fixture.workspaces, fixture.root)
      const { GitTimeoutError, toPublicGitError } = await import('./errors')
      const failing: GitRunnerLike = {
        runGit: () => Promise.reject(new GitTimeoutError())
      }
      const service = new GitService(fixture.workspaces, failing)
      // The service surfaces the typed timeout; the IPC layer maps it to
      // public copy (assert both halves: typed throw + safe mapping).
      await assert.rejects(service.getStatus({ workspaceId: id }), (error: unknown) => {
        assert.ok(error instanceof GitTimeoutError)
        const mapped = toPublicGitError('status', error)
        assert.equal(mapped.message, 'We couldn’t read Git status.')
        assert.ok(!mapped.message.includes('timed out') || mapped.message === 'We couldn’t read Git status.')
        return true
      })
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('never exposes raw spawn/absolute-path details', async () => {
    const fixture = openWorkspaces()
    try {
      const { toPublicGitError } = await import('./errors')
      const mapped = toPublicGitError('status', new Error('spawn git ENOENT /usr/bin/git'))
      assert.ok(!mapped.message.includes('ENOENT'))
      assert.ok(!mapped.message.includes('/usr/bin'))
      assert.ok(!mapped.message.includes('spawn'))
    } finally {
      fixture.db.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})
