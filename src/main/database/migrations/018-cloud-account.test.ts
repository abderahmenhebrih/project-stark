import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { getUserVersion, migrations, runMigrations } from './index'
import { migration017AiUsageThresholds } from './017-ai-usage-thresholds'
import { migration018CloudAccount } from './018-cloud-account'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

describe('migration 18 (cloud account)', () => {
  it('fresh database migrates to schema version 18', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
      assert.ok(tableExists(db, 'cloud_account'))
      assert.ok(tableExists(db, 'cloud_auth_session'))
    } finally {
      db.close()
    }
  })

  it('v17 database upgrades to v19 preserving existing rows', () => {
    const db = openFresh()
    try {
      const without18 = migrations.filter((migration) => migration.version <= 17)
      assert.equal(runMigrations(db, without18), 17)
      db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{\"a\":1}', 1)")
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
      const settings: unknown = db.prepare("SELECT value FROM key_value WHERE key = 'stark.settings'").get()
      assert.equal(JSON.stringify(settings), JSON.stringify({ value: '{"a":1}' }))
      const workspace: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()
      assert.equal(JSON.stringify(workspace), JSON.stringify({ n: 1 }))
      assert.ok(tableExists(db, 'cloud_account'))
      assert.ok(tableExists(db, 'cloud_auth_session'))
    } finally {
      db.close()
    }
  })

  it('migration 18 creates singleton tables with provider check', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migrations[0], migration017AiUsageThresholds, migration018CloudAccount].filter((m) => m.version <= 18))
      assert.ok(tableExists(db, 'cloud_account'))
      assert.ok(tableExists(db, 'cloud_auth_session'))
      db.exec('PRAGMA foreign_keys = ON')
      // Valid providers persist.
      db.exec(
        "INSERT INTO cloud_account (id, cloud_user_id, provider, created_at, updated_at, last_authenticated_at) " +
          "VALUES (1, 'u1', 'google', 1, 1, 1)"
      )
      db.exec("DELETE FROM cloud_account WHERE id = 1")
      db.exec(
        "INSERT INTO cloud_account (id, cloud_user_id, provider, created_at, updated_at, last_authenticated_at) " +
          "VALUES (1, 'u2', 'github', 1, 1, 1)"
      )
      db.exec("DELETE FROM cloud_account WHERE id = 1")
      // Invalid provider rejected at the database boundary.
      assert.throws(() =>
        db.exec(
          "INSERT INTO cloud_account (id, cloud_user_id, provider, created_at, updated_at, last_authenticated_at) " +
            "VALUES (1, 'u3', 'discord', 1, 1, 1)"
        )
      )
    } finally {
      db.close()
    }
  })

  it('rerunning v18 is idempotent and keeps account rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec(
        "INSERT INTO cloud_account (id, cloud_user_id, provider, created_at, updated_at, last_authenticated_at) " +
          "VALUES (1, 'u1', 'google', 1, 1, 1)"
      )
      assert.equal(runMigrations(db, migrations), 19)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM cloud_account').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('migrations remain registered in ascending order ending at 19', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    )
  })
})
