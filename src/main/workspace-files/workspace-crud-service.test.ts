import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { Workspace } from '../../shared/workspace/types'
import { InvalidWorkspaceError } from '../workspace/errors'
import {
  WorkspaceEntryExistsError,
  WorkspaceInvalidNameError,
  WorkspaceRootProtectedError,
  WorkspaceTrashError
} from './errors'
import { parseNameField, WorkspaceCrudService, type WorkspaceTrashFn } from './workspace-crud-service'

interface Fixture {
  db: DatabaseSync
  service: WorkspaceCrudService
  trashed: string[]
  root: string
  dir: string
  workspace: Workspace
}

function openFixture(trash?: WorkspaceTrashFn): Fixture {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const repository = new WorkspaceRepository(db)
  const trashed: string[] = []
  // Fake Trash: records the target and removes it like the OS shell.
  const fakeTrash: WorkspaceTrashFn = trash ?? (async (absolutePath: string) => {
    trashed.push(absolutePath)
    rmSync(absolutePath, { recursive: true, force: true })
  })
  const service = new WorkspaceCrudService(repository, fakeTrash)
  const dir = mkdtempSync(join(tmpdir(), 'stark-wscrud-'))
  const root = join(dir, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'main.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'README.md'), '# Test\n')
  const workspace = repository.create({ rootPath: root, displayName: 'project', now: 1000 })
  return { db, service, trashed, root, dir, workspace }
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

describe('explorer CRUD leaf names', () => {
  it('accepts plain names and rejects hostile ones', () => {
    assert.equal(parseNameField('index.ts'), 'index.ts')
    assert.equal(parseNameField('my component.tsx'), 'my component.tsx')
    for (const bad of ['', 'a/b', 'a\\b', '.', '..', 'nul\0byte', 'a'.repeat(256), 'trailing.']) {
      assert.throws(() => parseNameField(bad), WorkspaceInvalidNameError)
    }
    assert.throws(() => parseNameField(' leading'), WorkspaceInvalidNameError)
    assert.throws(() => parseNameField('trailing '), WorkspaceInvalidNameError)
    if (process.platform === 'win32') {
      assert.throws(() => parseNameField('CON'), WorkspaceInvalidNameError)
      assert.throws(() => parseNameField('com1.txt'), WorkspaceInvalidNameError)
    }
    assert.throws(() => parseNameField(null), WorkspaceInvalidNameError)
  })
})

describe('explorer CRUD create', () => {
  it('creates a file exclusively and refreshes through listings', async () => {
    const fixture = openFixture()
    try {
      const result = await fixture.service.createTextFile({ workspaceId: fixture.workspace.id, parentPath: '', name: 'notes.txt' })
      assert.equal(result.relativePath, 'notes.txt')
      assert.equal(result.kind, 'file')
      assert.equal(readFileSync(join(fixture.root, 'notes.txt'), 'utf8'), '')
      // Duplicate create is rejected — never merged or overwritten.
      writeFileSync(join(fixture.root, 'notes.txt'), 'human content\n')
      await assert.rejects(
        fixture.service.createTextFile({ workspaceId: fixture.workspace.id, parentPath: '', name: 'notes.txt' }),
        WorkspaceEntryExistsError
      )
      assert.equal(readFileSync(join(fixture.root, 'notes.txt'), 'utf8'), 'human content\n')
    } finally {
      closeFixture(fixture)
    }
  })

  it('creates a folder without merging into an existing one', async () => {
    const fixture = openFixture()
    try {
      const result = await fixture.service.createDirectory({ workspaceId: fixture.workspace.id, parentPath: '', name: 'components' })
      assert.equal(result.relativePath, 'components')
      assert.equal(result.kind, 'directory')
      await assert.rejects(
        fixture.service.createDirectory({ workspaceId: fixture.workspace.id, parentPath: '', name: 'components' }),
        WorkspaceEntryExistsError
      )
      // Existing folders are untouched by failed duplicates.
      await assert.rejects(
        fixture.service.createDirectory({ workspaceId: fixture.workspace.id, parentPath: '', name: 'src' }),
        WorkspaceEntryExistsError
      )
    } finally {
      closeFixture(fixture)
    }
  })

  it('creates inside subfolders and rejects traversal', async () => {
    const fixture = openFixture()
    try {
      const result = await fixture.service.createTextFile({ workspaceId: fixture.workspace.id, parentPath: 'src', name: 'app.ts' })
      assert.equal(result.relativePath, 'src/app.ts')
      assert.ok(existsSync(join(fixture.root, 'src', 'app.ts')))
      for (const evil of [
        { workspaceId: fixture.workspace.id, parentPath: '../outside', name: 'x.txt' },
        { workspaceId: fixture.workspace.id, parentPath: '/abs', name: 'x.txt' },
        { workspaceId: fixture.workspace.id, parentPath: 'src', name: '../x.txt' },
        { workspaceId: fixture.workspace.id, parentPath: 'src', name: 'a/b.txt' }
      ]) {
        await assert.rejects(fixture.service.createTextFile(evil))
      }
      assert.ok(!existsSync(join(fixture.dir, 'outside', 'x.txt')))
      await assert.rejects(
        fixture.service.createTextFile({ workspaceId: 999999, parentPath: '', name: 'x.txt' })
      )
      await assert.rejects(fixture.service.createTextFile({ workspaceId: fixture.workspace.id, parentPath: '', name: 'x.txt', extra: 1 }))
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('explorer CRUD leaf-name change', () => {
  it('renames files and folders inside the same parent', async () => {
    const fixture = openFixture()
    try {
      const file = await fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'README.md', newName: 'README2.md' })
      assert.equal(file.relativePath, 'README2.md')
      assert.ok(existsSync(join(fixture.root, 'README2.md')))
      assert.ok(!existsSync(join(fixture.root, 'README.md')))
      const folder = await fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'src', newName: 'source' })
      assert.equal(folder.relativePath, 'source')
      assert.ok(existsSync(join(fixture.root, 'source', 'main.ts')))
    } finally {
      closeFixture(fixture)
    }
  })

  it('refuses overwrites, the root, and hostile names', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(
        fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'README.md', newName: 'src' }),
        WorkspaceEntryExistsError
      )
      await assert.rejects(
        fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: '', newName: 'other' }),
        WorkspaceRootProtectedError
      )
      for (const bad of ['../evil', 'a/b', '', '.']) {
        await assert.rejects(
          fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'README.md', newName: bad })
        )
      }
      // Nothing was clobbered by the refused operations.
      assert.ok(existsSync(join(fixture.root, 'README.md')))
      assert.ok(existsSync(join(fixture.root, 'src', 'main.ts')))
    } finally {
      closeFixture(fixture)
    }
  })

  it('handles case-only changes without touching neighbors', async () => {
    const fixture = openFixture()
    try {
      const result = await fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'README.md', newName: 'readme.md' })
      assert.ok(result.relativePath.toLowerCase() === 'readme.md')
      // The sibling file survived regardless of platform semantics.
      assert.ok(existsSync(join(fixture.root, 'src', 'main.ts')))
    } finally {
      closeFixture(fixture)
    }
  })

  it('rejects malformed payloads and non-files', async () => {
    const fixture = openFixture()
    try {
      await assert.rejects(fixture.service.setEntryName(null), InvalidWorkspaceError)
      await assert.rejects(
        fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'missing.txt', newName: 'x.txt' })
      )
      try {
        symlinkSync(join(fixture.root, 'README.md'), join(fixture.root, 'link-file'), 'file')
        await assert.rejects(
          fixture.service.setEntryName({ workspaceId: fixture.workspace.id, relativePath: 'link-file', newName: 'link2' })
        )
      } catch {
        // Link privileges unavailable — symlink refusal covered elsewhere.
      }
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('explorer CRUD trash', () => {
  it('moves files and folders to Trash (never permanent)', async () => {
    const fixture = openFixture()
    try {
      const file = await fixture.service.moveToTrash({ workspaceId: fixture.workspace.id, relativePath: 'README.md' })
      assert.equal(file.kind, 'file')
      assert.deepEqual(fixture.trashed, [join(fixture.root, 'README.md')])
      assert.ok(!existsSync(join(fixture.root, 'README.md')))
      const folder = await fixture.service.moveToTrash({ workspaceId: fixture.workspace.id, relativePath: 'src' })
      assert.equal(folder.kind, 'directory')
      assert.ok(!existsSync(join(fixture.root, 'src')))
      assert.equal(fixture.trashed.length, 2)
    } finally {
      closeFixture(fixture)
    }
  })

  it('protects the workspace root and fails closed when Trash is unavailable', async () => {
    const fixture = openFixture(async () => {
      throw new Error('OS trash unavailable')
    })
    try {
      await assert.rejects(
        fixture.service.moveToTrash({ workspaceId: fixture.workspace.id, relativePath: '' }),
        WorkspaceRootProtectedError
      )
      assert.ok(existsSync(fixture.root))
      await assert.rejects(
        fixture.service.moveToTrash({ workspaceId: fixture.workspace.id, relativePath: 'README.md' }),
        WorkspaceTrashError
      )
      // Failed Trash leaves the file exactly where it was — no fallback deletion.
      assert.ok(existsSync(join(fixture.root, 'README.md')))
      await assert.rejects(fixture.service.moveToTrash({ workspaceId: fixture.workspace.id, relativePath: 'missing.txt' }))
    } finally {
      closeFixture(fixture)
    }
  })
})

describe('explorer CRUD isolation', () => {
  it('touches no AI transaction surface', async () => {
    const { readFileSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const source = readFileSync(joinPath(process.cwd(), 'src', 'main', 'workspace-files', 'workspace-crud-service.ts'), 'utf8')
    for (const forbidden of ['change-transaction', 'ChangeTransaction', 'createFileChange', 'proposal', 'acceptChange']) {
      assert.ok(!source.includes(forbidden), `crud service must not contain ${forbidden}`)
    }
  })
})
