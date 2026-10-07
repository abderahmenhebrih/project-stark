import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import {
  InvalidWorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceUnavailableError
} from './errors'
import { deriveDisplayName, WorkspaceService } from './workspace-service'

function makeTempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name))
}

function openService(clock?: () => number): {
  db: DatabaseSync
  service: WorkspaceService
  dir: string
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const dir = makeTempDir('stark-ws-svc-')
  const service = new WorkspaceService(new WorkspaceRepository(db), clock === undefined ? {} : { now: clock })
  return { db, service, dir }
}

function closeAll(db: DatabaseSync, dir: string): void {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

describe('WorkspaceService', () => {
  it('opens a valid directory', async () => {
    const { db, service, dir } = openService(() => 1000)
    try {
      const workspace = await service.openDirectory(dir)
      assert.ok(workspace.id > 0)
      assert.equal(workspace.createdAt, 1000)
      assert.equal(workspace.lastOpenedAt, 1000)
    } finally {
      closeAll(db, dir)
    }
  })

  it('canonicalizes redundant path spellings', async () => {
    const { db, service, dir } = openService()
    try {
      const withSeparator = dir + sep
      const workspace = await service.openDirectory(withSeparator)
      assert.equal(workspace.rootPath, dir)
      const reopened = await service.openDirectory(dir)
      assert.equal(reopened.id, workspace.id)
    } finally {
      closeAll(db, dir)
    }
  })

  it('derives display names from basenames with a root fallback', () => {
    assert.equal(deriveDisplayName(join('C:', 'proj', 'stark')), 'stark')
    assert.equal(deriveDisplayName(join('C:', 'proj', 'stark') + sep), 'stark')
    const root = parse(process.cwd()).root
    assert.equal(deriveDisplayName(root), root)
  })

  it('reopening the same directory reuses the row and refreshes recency', async () => {
    let now = 1000
    const { db, service, dir } = openService(() => now)
    try {
      const first = await service.openDirectory(dir)
      now = 2000
      const second = await service.openDirectory(dir)
      assert.equal(second.id, first.id)
      assert.equal(second.createdAt, 1000)
      assert.equal(second.lastOpenedAt, 2000)
      assert.equal(new WorkspaceRepository(db).listRecent(10).length, 1)
    } finally {
      closeAll(db, dir)
    }
  })

  it('missing directories are rejected', async () => {
    const { db, service, dir } = openService()
    try {
      await assert.rejects(service.openDirectory(join(dir, 'nope')), WorkspaceUnavailableError)
      const gone = join(dir, 'gone')
      mkdirSync(gone)
      const created = await service.openDirectory(gone)
      assert.ok(created.id > 0)
      rmSync(gone, { recursive: true, force: true })
      assert.equal(await service.getCurrentWorkspace(), null)
    } finally {
      closeAll(db, dir)
    }
  })

  it('file paths are rejected', async () => {
    const { db, service, dir } = openService()
    try {
      const file = join(dir, 'note.txt')
      writeFileSync(file, 'hi')
      await assert.rejects(service.openDirectory(file), WorkspaceUnavailableError)
    } finally {
      closeAll(db, dir)
    }
  })

  it('non-string paths are rejected', async () => {
    const { db, service, dir } = openService()
    try {
      for (const bad of [null, undefined, 42, {}, ['x']]) {
        await assert.rejects(service.openDirectory(bad), InvalidWorkspaceError)
      }
      await assert.rejects(service.openDirectory('relative/path'), InvalidWorkspaceError)
    } finally {
      closeAll(db, dir)
    }
  })

  it('getCurrent returns the most recent valid workspace', async () => {
    let now = 1000
    const { db, service, dir } = openService(() => now)
    try {
      assert.equal(await service.getCurrentWorkspace(), null)
      const first = join(dir, 'first')
      const second = join(dir, 'second')
      mkdirSync(first)
      mkdirSync(second)
      now = 2000
      await service.openDirectory(first)
      now = 3000
      const opened = await service.openDirectory(second)
      assert.deepEqual(await service.getCurrentWorkspace(), opened)
    } finally {
      closeAll(db, dir)
    }
  })

  it('missing current directory yields null without deleting history', async () => {
    const { db, service, dir } = openService()
    try {
      const target = join(dir, 'vanish')
      mkdirSync(target)
      await service.openDirectory(target)
      rmSync(target, { recursive: true, force: true })
      assert.equal(await service.getCurrentWorkspace(), null)
      assert.equal((await service.listRecentWorkspaces()).length, 1)
    } finally {
      closeAll(db, dir)
    }
  })

  it('open by id validates, resolves, and refreshes', async () => {
    let now = 1000
    const { db, service, dir } = openService(() => now)
    try {
      const created = await service.openDirectory(dir)
      now = 9000
      const reopened = await service.openWorkspaceById(created.id)
      assert.equal(reopened.id, created.id)
      assert.equal(reopened.lastOpenedAt, 9000)
      for (const bad of ['1', Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 1.5, {}, [1], null]) {
        await assert.rejects(service.openWorkspaceById(bad), InvalidWorkspaceError)
      }
      await assert.rejects(service.openWorkspaceById(created.id + 999), WorkspaceNotFoundError)
    } finally {
      closeAll(db, dir)
    }
  })

  it('open by id of a deleted directory fails safely', async () => {
    const { db, service, dir } = openService()
    try {
      const target = join(dir, 'doomed')
      mkdirSync(target)
      const created = await service.openDirectory(target)
      rmSync(target, { recursive: true, force: true })
      await assert.rejects(service.openWorkspaceById(created.id), WorkspaceUnavailableError)
      assert.equal((await service.listRecentWorkspaces()).length, 1)
    } finally {
      closeAll(db, dir)
    }
  })

  it('unicode directory names work', async () => {
    const { db, service, dir } = openService()
    try {
      const target = join(dir, 'stark-ws-tést-Ünï')
      mkdirSync(target)
      const opened = await service.openDirectory(target)
      assert.equal(opened.displayName, 'stark-ws-tést-Ünï')
      assert.deepEqual(await service.getCurrentWorkspace(), opened)
    } finally {
      closeAll(db, dir)
    }
  })

  it('recent list defaults to newest-first with a limit of 8', async () => {
    let now = 1000
    const { db, service, dir } = openService(() => now)
    try {
      for (let i = 0; i < 10; i += 1) {
        const target = join(dir, `proj-${i}`)
        mkdirSync(target)
        now += 1000
        await service.openDirectory(target)
      }
      const recent = await service.listRecentWorkspaces()
      assert.equal(recent.length, 8)
      assert.equal(recent[0]?.displayName, 'proj-9')
      assert.equal(recent[7]?.displayName, 'proj-2')
    } finally {
      closeAll(db, dir)
    }
  })
})
