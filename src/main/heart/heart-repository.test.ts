import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { HeartRepository } from './heart-repository'
import { DatabaseError } from '../database/errors'

function openRepository(): { db: DatabaseSync; heart: HeartRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, heart: new HeartRepository(db) }
}

function fixedInput(now = 2000): {
  workerMode: string
  assignments: { role: string; routeKey: string; providerId: string; model: string }[]
  now: number
} {
  return {
    workerMode: 'fixed',
    assignments: [
      { role: 'brain', routeKey: 'primary', providerId: 'openai', model: 'model-A' },
      { role: 'worker', routeKey: 'fixed', providerId: 'openai', model: 'model-B' }
    ],
    now
  }
}

describe('heart repository', () => {
  it('starts unconfigured with no settings row', () => {
    const { db, heart } = openRepository()
    try {
      assert.equal(heart.findSettings(), undefined)
      assert.deepEqual(heart.listAssignments(), [])
    } finally {
      db.close()
    }
  })

  it('saves and loads a fixed config', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig(fixedInput())
      assert.equal(heart.findSettings()?.workerMode, 'fixed')
      assert.equal(heart.listAssignments().length, 2)
    } finally {
      db.close()
    }
  })

  it('saves an auto-swap config with profile overrides', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig({
        workerMode: 'auto_swap',
        assignments: [
          { role: 'brain', routeKey: 'primary', providerId: 'openai', model: 'model-A' },
          { role: 'worker', routeKey: 'default', providerId: 'openai', model: 'model-D' },
          { role: 'worker', routeKey: 'coding', providerId: 'openai', model: 'model-C' }
        ],
        now: 2000
      })
      assert.equal(heart.findSettings()?.workerMode, 'auto_swap')
      assert.equal(heart.listAssignments().length, 3)
    } finally {
      db.close()
    }
  })

  it('replaces config atomically and deletes removed overrides', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig({
        workerMode: 'auto_swap',
        assignments: [
          { role: 'brain', routeKey: 'primary', providerId: 'openai', model: 'model-A' },
          { role: 'worker', routeKey: 'default', providerId: 'openai', model: 'model-D' },
          { role: 'worker', routeKey: 'coding', providerId: 'openai', model: 'model-C' }
        ],
        now: 2000
      })
      heart.saveConfig(fixedInput(3000))
      const rows = heart.listAssignments()
      assert.equal(rows.length, 2)
      assert.ok(!rows.some((row) => row.routeKey === 'coding' || row.routeKey === 'default'))
      assert.equal(heart.findSettings()?.workerMode, 'fixed')
    } finally {
      db.close()
    }
  })

  it('rolls back the whole save on injected failure', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig(fixedInput(2000))
      assert.throws(
        () =>
          heart.saveConfig(
            {
              workerMode: 'auto_swap',
              assignments: [
                { role: 'brain', routeKey: 'primary', providerId: 'openai', model: 'model-X' },
                { role: 'worker', routeKey: 'default', providerId: 'openai', model: 'model-Y' }
              ],
              now: 3000
            },
            { failAfterAssignments: 0 }
          ),
        DatabaseError
      )
      assert.equal(heart.findSettings()?.workerMode, 'fixed')
      assert.ok(heart.listAssignments().every((row) => row.model === 'model-A' || row.model === 'model-B'))
    } finally {
      db.close()
    }
  })

  it('singleton settings row keeps timestamps', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig(fixedInput(2000))
      heart.saveConfig(fixedInput(3000))
      assert.equal(heart.findSettings()?.updatedAt, 3000)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_heart_settings').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('stores no credentials anywhere', () => {
    const { db, heart } = openRepository()
    try {
      heart.saveConfig(fixedInput())
      const dump: unknown = db.prepare('SELECT sql FROM sqlite_master WHERE name LIKE \'ai_heart%\'').all()
      assert.ok(!JSON.stringify(dump).includes('credential'))
      assert.ok(!JSON.stringify(dump).includes('api_key'))
      const rows = heart.listAssignments()
      assert.ok(rows.every((row) => !JSON.stringify(row).includes('sk-')))
    } finally {
      db.close()
    }
  })
})
