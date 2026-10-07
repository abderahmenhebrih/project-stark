import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { GitProcessRunner } from './git-process-runner'
import { GitService } from './git-service'
import { MAX_GIT_DIFF_OUTPUT_BYTES, MAX_GIT_STATUS_OUTPUT_BYTES } from './limits'

const GIT_TIMEOUT = 5000
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0'
}

function gitAvailable(): boolean {
  try {
    const result = spawnSync('git', ['--version'], { timeout: GIT_TIMEOUT, env: GIT_ENV, encoding: 'utf8' })
    return result.status === 0
  } catch {
    return false
  }
}

function runGit(cwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, timeout: GIT_TIMEOUT, env: GIT_ENV, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function createTempRepo(): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-git-real-'))
  const root = realpathSync(dir)
  let result = runGit(root, ['init'])
  assert.equal(result.status, 0, `git init failed: ${result.stderr}`)
  result = runGit(root, ['config', 'user.name', 'Stark Test'])
  assert.equal(result.status, 0)
  result = runGit(root, ['config', 'user.email', 'stark-test@example.invalid'])
  assert.equal(result.status, 0)
  result = runGit(root, ['config', 'commit.gpgsign', 'false'])
  assert.equal(result.status, 0)
  return { dir, root }
}

function openServiceFor(root: string): { db: DatabaseSync; service: GitService; workspaceId: number; dir: string } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const created = workspaces.create({ rootPath: root, displayName: 'temp', now: Date.now() })
  const service = new GitService(workspaces, new GitProcessRunner({ timeoutMs: GIT_TIMEOUT }))
  return { db, service, workspaceId: created.id, dir: root }
}

describe('git real temp-repo integration (bounded, disposable)', () => {
  it('observes committed/unstaged/staged/untracked state and diffs', async () => {
    if (!gitAvailable()) {
      console.log('SKIP: system git unavailable — real repo test skipped explicitly')
      return
    }
    const { dir, root } = createTempRepo()
    const opened = openServiceFor(root)
    try {
      writeFileSync(join(root, 'committed.txt'), 'line one\nline two\n')
      writeFileSync(join(root, 'staged-file.txt'), 'staged base\n')
      let result = runGit(root, ['add', 'committed.txt', 'staged-file.txt'])
      assert.equal(result.status, 0, result.stderr)
      result = runGit(root, ['commit', '-m', 'initial'])
      assert.equal(result.status, 0, result.stderr)
      // Unstaged modification.
      writeFileSync(join(root, 'committed.txt'), 'line one\nline two CHANGED\n')
      // Staged modification.
      writeFileSync(join(root, 'staged-file.txt'), 'staged base CHANGED\n')
      result = runGit(root, ['add', 'staged-file.txt'])
      assert.equal(result.status, 0, result.stderr)
      // Untracked file.
      writeFileSync(join(root, 'untracked.txt'), 'hello untracked\n')

      const state = await opened.service.getStatus({ workspaceId: opened.workspaceId })
      assert.equal(state.kind, 'ready')
      if (state.kind !== 'ready') {
        return
      }
      assert.equal(state.clean, false)
      const paths = state.files.map((entry) => entry.relativePath)
      assert.ok(paths.includes('committed.txt'), `missing committed.txt in ${paths.join(',')}`)
      assert.ok(paths.includes('staged-file.txt'), `missing staged-file.txt in ${paths.join(',')}`)
      assert.ok(paths.includes('untracked.txt'), `missing untracked.txt in ${paths.join(',')}`)
      const committed = state.files.find((entry) => entry.relativePath === 'committed.txt')
      assert.equal(committed?.unstaged, true)
      const staged = state.files.find((entry) => entry.relativePath === 'staged-file.txt')
      assert.equal(staged?.staged, true)
      const untracked = state.files.find((entry) => entry.relativePath === 'untracked.txt')
      assert.equal(untracked?.untracked, true)

      const unstagedDiff = await opened.service.getDiff({
        workspaceId: opened.workspaceId,
        relativePath: 'committed.txt',
        target: 'unstaged'
      })
      assert.ok(unstagedDiff.patch.includes('CHANGED'))

      const stagedDiff = await opened.service.getDiff({
        workspaceId: opened.workspaceId,
        relativePath: 'staged-file.txt',
        target: 'staged'
      })
      assert.ok(stagedDiff.patch.includes('CHANGED'))
    } finally {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('read-only integrity: status/diff change nothing', async () => {
    if (!gitAvailable()) {
      console.log('SKIP: system git unavailable — integrity test skipped explicitly')
      return
    }
    const { dir, root } = createTempRepo()
    const opened = openServiceFor(root)
    try {
      writeFileSync(join(root, 'file.txt'), 'alpha\nbeta\n')
      let result = runGit(root, ['add', 'file.txt'])
      assert.equal(result.status, 0)
      result = runGit(root, ['commit', '-m', 'init'])
      assert.equal(result.status, 0)
      writeFileSync(join(root, 'file.txt'), 'alpha\nbeta changed\n')
      writeFileSync(join(root, 'staged.txt'), 'staged content\n')
      result = runGit(root, ['add', 'staged.txt'])
      assert.equal(result.status, 0)
      // Also commit staged.txt so staged.txt is clean? No — keep staged change.
      // Snapshot before Stage 12 reads.
      const beforeWorking = readFileSync(join(root, 'file.txt'))
      const beforeStaged = readFileSync(join(root, 'staged.txt'))
      const indexPath = join(root, '.git', 'index')
      const beforeIndex = existsSync(indexPath) ? readFileSync(indexPath) : null
      const headBefore = runGit(root, ['rev-parse', 'HEAD'])
      assert.equal(headBefore.status, 0)

      await opened.service.getStatus({ workspaceId: opened.workspaceId })
      await opened.service.getDiff({ workspaceId: opened.workspaceId, relativePath: 'file.txt', target: 'unstaged' })
      await opened.service.getDiff({ workspaceId: opened.workspaceId, relativePath: 'staged.txt', target: 'staged' })

      assert.deepEqual(readFileSync(join(root, 'file.txt')), beforeWorking)
      assert.deepEqual(readFileSync(join(root, 'staged.txt')), beforeStaged)
      if (beforeIndex !== null) {
        assert.deepEqual(readFileSync(indexPath), beforeIndex, '.git/index bytes must be unchanged')
      }
      const headAfter = runGit(root, ['rev-parse', 'HEAD'])
      assert.equal(headAfter.stdout, headBefore.stdout, 'HEAD must be unchanged')
      assert.ok(MAX_GIT_STATUS_OUTPUT_BYTES === 2 * 1024 * 1024)
      assert.ok(MAX_GIT_DIFF_OUTPUT_BYTES === 2 * 1024 * 1024)
    } finally {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('root-mismatch: subfolder of a parent repo is refused', async () => {
    if (!gitAvailable()) {
      console.log('SKIP: system git unavailable — root-mismatch test skipped explicitly')
      return
    }
    const parent = mkdtempSync(join(tmpdir(), 'stark-git-parent-'))
    const parentRoot = realpathSync(parent)
    let result = runGit(parentRoot, ['init'])
    assert.equal(result.status, 0)
    result = runGit(parentRoot, ['config', 'user.name', 'Stark Test'])
    assert.equal(result.status, 0)
    result = runGit(parentRoot, ['config', 'user.email', 'stark-test@example.invalid'])
    assert.equal(result.status, 0)
    const subfolder = join(parentRoot, 'selectedSubfolder')
    mkdirSync(subfolder, { recursive: true })
    writeFileSync(join(subfolder, 'note.txt'), 'inside subfolder\n')
    const opened = openServiceFor(realpathSync(subfolder))
    try {
      const state = await opened.service.getStatus({ workspaceId: opened.workspaceId })
      assert.equal(state.kind, 'root-mismatch')
    } finally {
      opened.db.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('external diff/textconv is never invoked (--no-ext-diff --no-textconv)', async () => {
    if (!gitAvailable()) {
      console.log('SKIP: system git unavailable — external-diff test skipped explicitly')
      return
    }
    const { dir, root } = createTempRepo()
    const opened = openServiceFor(root)
    try {
      writeFileSync(join(root, 'doc.txt'), 'original\n')
      let result = runGit(root, ['add', 'doc.txt'])
      assert.equal(result.status, 0)
      result = runGit(root, ['commit', '-m', 'init'])
      assert.equal(result.status, 0)
      writeFileSync(join(root, 'doc.txt'), 'modified\n')
      // Configure a local external diff driver that would leave a marker
      // if Git ever executed it. Local repo config only — never global.
      const marker = join(root, 'external-marker.txt')
      const scriptName = process.platform === 'win32' ? 'ext-diff.cmd' : 'ext-diff.sh'
      const scriptPath = join(root, scriptName)
      if (process.platform === 'win32') {
        writeFileSync(scriptPath, `@echo off\r\necho MARKER > "${marker}"\r\n`)
      } else {
        writeFileSync(scriptPath, `#!/bin/sh\ntouch "${marker}"\n`)
        try {
          const { chmodSync } = await import('node:fs')
          chmodSync(scriptPath, 0o755)
        } catch {
          // Best effort.
        }
      }
      result = runGit(root, ['config', 'diff.external', scriptPath])
      assert.equal(result.status, 0, result.stderr)
      result = runGit(root, ['config', 'diff.fake.textconv', `touch "${marker}"`])
      assert.equal(result.status, 0, result.stderr)

      const diff = await opened.service.getDiff({
        workspaceId: opened.workspaceId,
        relativePath: 'doc.txt',
        target: 'unstaged'
      })
      assert.ok(typeof diff.patch === 'string')
      assert.ok(!existsSync(marker), 'external diff driver must NOT have run')
    } finally {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
