import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { MigrationError } from '../errors'
import type { Migration } from '../types'
import { getUserVersion, migrations, runMigrations } from './index'
import { migration001Initial } from './001-initial'
import { migration002Workspaces } from './002-workspaces'
import { migration003ChangeTransactions } from './003-change-transactions'
import { migration004CodingSessions } from './004-coding-sessions'
import { migration005AiProviders } from './005-ai-providers'
import { migration006MessageContext } from './006-message-context'
import { migration007ChangeSets } from './007-change-sets'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

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

function seedV6(db: DatabaseSync): void {
  assert.equal(
    runMigrations(db, [
      migration001Initial,
      migration002Workspaces,
      migration003ChangeTransactions,
      migration004CodingSessions,
      migration005AiProviders,
      migration006MessageContext
    ]),
    6
  )
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{}', 1)")
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec(
    "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
      "VALUES (1, 'manual-note', 'Note', NULL, NULL, NULL, 'hi', 2, 1)"
  )
  db.exec(
    "INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-4o', 1, 1)"
  )
}

describe('migration 7 (change sets)', () => {
  it('fresh DB migrates to v7', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(getUserVersion(db), 18)
    } finally {
      db.close()
    }
  })

  it('v6 database upgrades to v7', () => {
    const db = openFresh()
    try {
      seedV6(db)
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(getUserVersion(db), 18)
    } finally {
      db.close()
    }
  })

  it('preserves all v6 tables and rows', () => {
    const db = openFresh()
    try {
      seedV6(db)
      assert.equal(runMigrations(db, migrations), 18)
      for (const table of [
        'key_value',
        'workspaces',
        'change_transactions',
        'coding_sessions',
        'coding_messages',
        'message_context_items',
        'ai_provider_configs'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates the change-set tables with the workspace index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'change_sets'))
      assert.ok(tableExists(db, 'change_set_items'))
      assert.ok(indexExists(db, 'idx_change_sets_workspace_created'))
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys on the change-set tables', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec("INSERT INTO change_sets (workspace_id, kind, summary, created_at, updated_at) VALUES (999, 'ai_multi_file_proposal', 's', 1, 1)")
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
      assert.throws(() =>
        db.exec('INSERT INTO change_set_items (change_set_id, transaction_id, ordinal, file_summary) VALUES (999, 1, 0, \'s\')')
      )
      assert.throws(() =>
        db.exec('INSERT INTO change_set_items (change_set_id, transaction_id, ordinal, file_summary) VALUES (1, 999, 0, \'s\')')
      )
    } finally {
      db.close()
    }
  })

  it('keeps old ungrouped change transactions valid', () => {
    const db = openFresh()
    try {
      seedV6(db)
      assert.equal(runMigrations(db, migrations), 18)
      const count: unknown = db.prepare("SELECT COUNT(*) AS n FROM change_transactions WHERE status = 'pending'").get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
      const sets: unknown = db.prepare('SELECT COUNT(*) AS n FROM change_sets').get()
      assert.equal(JSON.stringify(sets), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning v7 is idempotent and keeps change sets', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO change_sets (workspace_id, kind, summary, created_at, updated_at) VALUES (1, 'ai_multi_file_proposal', 's', 1, 1)")
      assert.equal(runMigrations(db, migrations), 18)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM change_sets').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v7 migration rolls back without marking version 7', () => {
    const db = openFresh()
    try {
      seedV6(db)
      const failingV7: Migration = {
        version: 7,
        name: 'broken-change-sets',
        up(target): void {
          target.exec('CREATE TABLE change_sets (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(
        () =>
          runMigrations(db, [
            migration001Initial,
            migration002Workspaces,
            migration003ChangeTransactions,
            migration004CodingSessions,
            migration005AiProviders,
            migration006MessageContext,
            failingV7
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 6)
      assert.equal(tableExists(db, 'change_set_items'), false)
    } finally {
      db.close()
    }
  })

  it('migration 7 is registered after migration 6', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
    )
    assert.equal(migration007ChangeSets.version, 7)
  })
})
