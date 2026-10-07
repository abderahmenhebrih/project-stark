import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { InvalidWorkspaceError } from '../workspace/errors'
import { WorkspaceEntryTypeError, WorkspacePathOutsideRootError } from './errors'
import { resolveWorkspacePath } from './workspace-path'

function makeFixture(): { dir: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stark-wspath-'))
  const project = join(dir, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  return { dir, project }
}

function closeFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function tryJunction(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'junction')
    return true
  } catch {
    return false
  }
}

describe('workspace path resolution', () => {
  it('resolves the root path', async () => {
    const { dir, project } = makeFixture()
    try {
      const resolved = await resolveWorkspacePath(project, '')
      assert.deepEqual(resolved.relativePath, '')
    } finally {
      closeFixture(dir)
    }
  })

  it('resolves a normal nested path', async () => {
    const { dir, project } = makeFixture()
    try {
      const resolved = await resolveWorkspacePath(project, 'src')
      assert.equal(resolved.relativePath, 'src')
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects parent traversal anywhere', async () => {
    const { dir, project } = makeFixture()
    try {
      for (const bad of ['..', '../', '..\\', 'src/../..', 'src/../../evil', 'a/b/../../../c']) {
        await assert.rejects(resolveWorkspacePath(project, bad), WorkspacePathOutsideRootError)
      }
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects absolute paths', async () => {
    const { dir, project } = makeFixture()
    try {
      await assert.rejects(resolveWorkspacePath(project, '/etc/hosts'), InvalidWorkspaceError)
      await assert.rejects(resolveWorkspacePath(project, dir), InvalidWorkspaceError)
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects drive-prefixed and UNC-style paths', async () => {
    const { dir, project } = makeFixture()
    try {
      await assert.rejects(resolveWorkspacePath(project, 'C:\\Windows'), InvalidWorkspaceError)
      await assert.rejects(resolveWorkspacePath(project, 'C:/Windows'), InvalidWorkspaceError)
      await assert.rejects(resolveWorkspacePath(project, '\\\\server\\share'), InvalidWorkspaceError)
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects NUL bytes and overlong input', async () => {
    const { dir, project } = makeFixture()
    try {
      await assert.rejects(resolveWorkspacePath(project, 'src/\0evil'), InvalidWorkspaceError)
      await assert.rejects(resolveWorkspacePath(project, 'x'.repeat(4097)), InvalidWorkspaceError)
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects non-string input', async () => {
    const { dir, project } = makeFixture()
    try {
      for (const bad of [null, undefined, 42, {}, ['src']]) {
        await assert.rejects(resolveWorkspacePath(project, bad), InvalidWorkspaceError)
      }
    } finally {
      closeFixture(dir)
    }
  })

  it('normalizes redundant separators and dots', async () => {
    const { dir, project } = makeFixture()
    try {
      const resolved = await resolveWorkspacePath(project, 'src//./')
      assert.equal(resolved.relativePath, 'src')
    } finally {
      closeFixture(dir)
    }
  })

  it('matches case-insensitively on case-insensitive filesystems', async () => {
    const { dir, project } = makeFixture()
    try {
      if (process.platform === 'win32' || process.platform === 'darwin') {
        const resolved = await resolveWorkspacePath(project, 'SRC')
        assert.equal(resolved.relativePath, 'SRC')
      } else {
        await assert.rejects(resolveWorkspacePath(project, 'SRC'))
      }
    } finally {
      closeFixture(dir)
    }
  })

  it('rejects a symlink pointing outside the workspace', async () => {
    const { dir, project } = makeFixture()
    try {
      const outside = join(dir, 'project-evil')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'secrets.txt'), 'x')
      const link = join(project, 'external-link')
      if (!tryJunction(outside, link)) {
        console.warn('skipped: cannot create junctions on this platform')
        return
      }
      // The link itself is refused before containment is even consulted.
      await assert.rejects(
        resolveWorkspacePath(project, 'external-link/secrets.txt'),
        WorkspaceEntryTypeError
      )
      await assert.rejects(resolveWorkspacePath(project, 'external-link'), WorkspaceEntryTypeError)
    } finally {
      closeFixture(dir)
    }
  })
})
