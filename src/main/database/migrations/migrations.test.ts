import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { DatabaseError, MigrationError } from '../errors'
import type { Migration } from '../types'
import { getUserVersion, migrations, runMigrations, validateMigrations } from './index'
import { migration001Initial } from './001-initial'
import { migration002Workspaces } from './002-workspaces'
import { migration003ChangeTransactions } from './003-change-transactions'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

describe('migrations', () => {
  it('brand new database starts at schema version 0', () => {
    const db = openFresh()
    try {
      assert.equal(getUserVersion(db), 0)
    } finally {
      db.close()
    }
  })

  it('migration 1 applies on its own and sets schema version to 1', () => {
    const db = openFresh()
    try {
      const version = runMigrations(db, [migration001Initial])
      assert.equal(version, 1)
      assert.equal(getUserVersion(db), 1)
    } finally {
      db.close()
    }
  })

  it('migration 1 creates the key_value table', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      const row: unknown = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'key_value'")
        .get()
      assert.notEqual(row, undefined)
    } finally {
      db.close()
    }
  })

  it('running migrations again is idempotent', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 6)
      assert.equal(runMigrations(db, migrations), 6)
      assert.equal(getUserVersion(db), 6)
    } finally {
      db.close()
    }
  })

  it('duplicate migration versions are rejected', () => {
    const dupe: Migration = { version: 1, name: 'dupe', up(): void {} }
    assert.throws(() => validateMigrations([migrations[0], dupe]), DatabaseError)
  })

  it('invalid versions are rejected', () => {
    const zero: Migration = { version: 0, name: 'zero', up(): void {} }
    const negative: Migration = { version: -2, name: 'negative', up(): void {} }
    const fractional: Migration = { version: 1.5, name: 'fractional', up(): void {} }
    assert.throws(() => validateMigrations([zero]), DatabaseError)
    assert.throws(() => validateMigrations([negative]), DatabaseError)
    assert.throws(() => validateMigrations([fractional]), DatabaseError)
  })

  it('out-of-order migrations are rejected', () => {
    const second: Migration = { version: 2, name: 'second', up(): void {} }
    assert.throws(() => validateMigrations([second, migrations[0]]), DatabaseError)
  })

  it('a failing migration does not mark the schema as upgraded', () => {
    const db = openFresh()
    try {
      const failing: Migration = {
        version: 1,
        name: 'boom',
        up(): void {
          throw new Error('boom')
        }
      }
      assert.throws(() => runMigrations(db, [failing]), MigrationError)
      assert.equal(getUserVersion(db), 0)
    } finally {
      db.close()
    }
  })

  it('a partially applied migration rolls back its schema changes', () => {
    const db = openFresh()
    try {
      const partial: Migration = {
        version: 1,
        name: 'partial',
        up(target): void {
          target.exec('CREATE TABLE partial_table (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(() => runMigrations(db, [partial]), MigrationError)
      assert.equal(getUserVersion(db), 0)
      const row: unknown = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table'")
        .get()
      assert.equal(row, undefined)
    } finally {
      db.close()
    }
  })
})

describe('migration 2 (workspaces)', () => {
  function tableExists(db: DatabaseSync, name: string): boolean {
    const row: unknown = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
    return row !== undefined
  }

  function indexExists(db: DatabaseSync, name: string): boolean {
    const row: unknown = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name)
    return row !== undefined
  }

  it('fresh database migrates to schema version 5', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 6)
      assert.equal(getUserVersion(db), 6)
      assert.ok(tableExists(db, 'key_value'))
      assert.ok(tableExists(db, 'workspaces'))
    } finally {
      db.close()
    }
  })

  it('migration 2 creates the workspaces table and recency index', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migration001Initial, migration002Workspaces])
      assert.ok(tableExists(db, 'workspaces'))
      assert.ok(indexExists(db, 'idx_workspaces_last_opened_at'))
    } finally {
      db.close()
    }
  })

  it('v1 to v2 preserves existing key_value rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, [migration001Initial]), 1)
      db.exec(
        "INSERT INTO key_value (key, value, updated_at) VALUES " +
          "('stark.settings', '{\"appearance\":\"dark\"}', 1), " +
          "('stark.profile', '{\"displayName\":\"Abdou\"}', 2)"
      )
      assert.equal(runMigrations(db, migrations), 6)
      const settings: unknown = db
        .prepare("SELECT value FROM key_value WHERE key = 'stark.settings'")
        .get()
      const profile: unknown = db
        .prepare("SELECT value FROM key_value WHERE key = 'stark.profile'")
        .get()
      // Raw rows use null prototypes, so compare serialized forms.
      assert.equal(JSON.stringify(settings), JSON.stringify({ value: '{"appearance":"dark"}' }))
      assert.equal(JSON.stringify(profile), JSON.stringify({ value: '{"displayName":"Abdou"}' }))
    } finally {
      db.close()
    }
  })

  it('rerunning v2 does nothing', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec(
        "INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) " +
          "VALUES ('C:\\proj\\a', 'a', 10, 20)"
      )
      assert.equal(runMigrations(db, migrations), 6)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('migrations are registered in ascending version order', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6]
    )
  })

  it('a failing v2 migration rolls back without marking version 2', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migration001Initial])
      const failingV2: Migration = {
        version: 2,
        name: 'broken-workspaces',
        up(target): void {
          target.exec('CREATE TABLE workspaces (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(() => runMigrations(db, [migration001Initial, failingV2]), MigrationError)
      assert.equal(getUserVersion(db), 1)
      assert.equal(tableExists(db, 'workspaces'), false)
    } finally {
      db.close()
    }
  })
})

describe('migration 3 (change transactions)', () => {
  function tableExists(db: DatabaseSync, name: string): boolean {
    const row: unknown = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
    return row !== undefined
  }

  function indexExists(db: DatabaseSync, name: string): boolean {
    const row: unknown = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name)
    return row !== undefined
  }

  it('fresh database migrates to v3 with both transaction tables and the workspace index', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, [migration001Initial, migration002Workspaces, migration003ChangeTransactions]), 3)
      assert.equal(getUserVersion(db), 3)
      assert.ok(tableExists(db, 'change_transactions'))
      assert.ok(tableExists(db, 'change_transaction_files'))
      assert.ok(indexExists(db, 'idx_change_transactions_workspace_created'))
    } finally {
      db.close()
    }
  })

  it('v2 to v3 preserves key_value, profile, settings, and Workspace rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, [migration001Initial, migration002Workspaces]), 2)
      db.exec(
        "INSERT INTO key_value (key, value, updated_at) VALUES " +
          "('stark.settings', '{\"appearance\":\"dark\"}', 1), " +
          "('stark.profile', '{\"displayName\":\"Abdou\"}', 2)"
      )
      db.exec(
        "INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) " +
          "VALUES ('C:\\proj\\a', 'a', 10, 20)"
      )
      assert.equal(runMigrations(db, migrations), 6)
      const settings: unknown = db.prepare("SELECT value FROM key_value WHERE key = 'stark.settings'").get()
      const profile: unknown = db.prepare("SELECT value FROM key_value WHERE key = 'stark.profile'").get()
      const workspace: unknown = db
        .prepare('SELECT root_path, display_name FROM workspaces WHERE root_path = ?')
        .get('C:\\proj\\a')
      assert.equal(JSON.stringify(settings), JSON.stringify({ value: '{"appearance":"dark"}' }))
      assert.equal(JSON.stringify(profile), JSON.stringify({ value: '{"displayName":"Abdou"}' }))
      assert.equal(JSON.stringify(workspace), JSON.stringify({ root_path: 'C:\\proj\\a', display_name: 'a' }))
    } finally {
      db.close()
    }
  })

  it('rerunning migrations is idempotent and keeps existing transaction rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec(
        "INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) " +
          "VALUES (1, 'pending', 1, 1)"
      )
      assert.equal(runMigrations(db, migrations), 6)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM change_transactions').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v3 migration rolls back without marking version 3', () => {
    const db = openFresh()
    try {
      runMigrations(db, [migration001Initial, migration002Workspaces])
      const failingV3: Migration = {
        version: 3,
        name: 'broken-changes',
        up(target): void {
          target.exec('CREATE TABLE change_transactions (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(
        () => runMigrations(db, [migration001Initial, migration002Workspaces, failingV3]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 2)
      assert.equal(tableExists(db, 'change_transactions'), false)
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys on the transaction tables', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (999, 'pending', 1, 1)")
      )
    } finally {
      db.close()
    }
  })

  it('rejects invalid statuses at the database boundary', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      assert.throws(() =>
        db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'draft', 1, 1)")
      )
    } finally {
      db.close()
    }
  })
})
