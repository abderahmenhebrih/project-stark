import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../migrations/index'
import { WorkspaceRepository } from './workspace-repository'

function openRepository(): { db: DatabaseSync; repo: WorkspaceRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, repo: new WorkspaceRepository(db) }
}

describe('WorkspaceRepository', () => {
  it('creates a workspace with an integer id', () => {
    const { db, repo } = openRepository()
    try {
      const created = repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a', now: 1000 })
      assert.equal(typeof created.id, 'number')
      assert.ok(created.id > 0)
      assert.deepEqual(created, {
        id: created.id,
        rootPath: 'C:\\proj\\a',
        displayName: 'a',
        createdAt: 1000,
        lastOpenedAt: 1000
      })
    } finally {
      db.close()
    }
  })

  it('finds workspaces by id', () => {
    const { db, repo } = openRepository()
    try {
      const created = repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a', now: 1000 })
      assert.deepEqual(repo.findById(created.id), created)
      assert.equal(repo.findById(created.id + 999), undefined)
    } finally {
      db.close()
    }
  })

  it('finds workspaces by exact root path', () => {
    const { db, repo } = openRepository()
    try {
      const created = repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a', now: 1000 })
      assert.deepEqual(repo.findByRootPath('C:\\proj\\a'), created)
      assert.equal(repo.findByRootPath('C:\\proj\\other'), undefined)
    } finally {
      db.close()
    }
  })

  it('duplicate root paths violate the unique constraint', () => {
    const { db, repo } = openRepository()
    try {
      repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a', now: 1000 })
      assert.throws(() => repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a2', now: 2000 }))
      assert.equal(repo.listRecent(10).length, 1)
    } finally {
      db.close()
    }
  })

  it('touch updates last_opened_at only', () => {
    const { db, repo } = openRepository()
    try {
      const created = repo.create({ rootPath: 'C:\\proj\\a', displayName: 'a', now: 1000 })
      repo.touchLastOpened(created.id, 5000)
      assert.deepEqual(repo.findById(created.id), { ...created, lastOpenedAt: 5000 })
    } finally {
      db.close()
    }
  })

  it('display names persist exactly', () => {
    const { db, repo } = openRepository()
    try {
      const created = repo.create({ rootPath: '/tmp/Ünïcodé tést', displayName: 'Ünïcodé tést', now: 1 })
      assert.deepEqual(repo.findById(created.id)?.displayName, 'Ünïcodé tést')
      assert.deepEqual(repo.findById(created.id)?.rootPath, '/tmp/Ünïcodé tést')
    } finally {
      db.close()
    }
  })

  it('listRecent sorts newest first and respects the limit', () => {
    const { db, repo } = openRepository()
    try {
      const first = repo.create({ rootPath: 'C:\\a', displayName: 'a', now: 100 })
      const second = repo.create({ rootPath: 'C:\\b', displayName: 'b', now: 200 })
      repo.create({ rootPath: 'C:\\c', displayName: 'c', now: 300 })
      repo.touchLastOpened(first.id, 400)
      const all = repo.listRecent(10)
      assert.deepEqual(
        all.map((entry) => entry.rootPath),
        ['C:\\a', 'C:\\c', 'C:\\b']
      )
      assert.deepEqual(
        repo.listRecent(2).map((entry) => entry.rootPath),
        ['C:\\a', 'C:\\c']
      )
      assert.ok(second.id > 0)
    } finally {
      db.close()
    }
  })

  it('getMostRecentlyOpened tracks recency', () => {
    const { db, repo } = openRepository()
    try {
      assert.equal(repo.getMostRecentlyOpened(), undefined)
      const first = repo.create({ rootPath: 'C:\\a', displayName: 'a', now: 100 })
      assert.deepEqual(repo.getMostRecentlyOpened()?.id, first.id)
      const second = repo.create({ rootPath: 'C:\\b', displayName: 'b', now: 200 })
      assert.deepEqual(repo.getMostRecentlyOpened()?.id, second.id)
      repo.touchLastOpened(first.id, 300)
      assert.deepEqual(repo.getMostRecentlyOpened()?.id, first.id)
    } finally {
      db.close()
    }
  })
})
