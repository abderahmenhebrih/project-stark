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

function seedV5(db: DatabaseSync): void {
  assert.equal(
    runMigrations(db, [
      migration001Initial,
      migration002Workspaces,
      migration003ChangeTransactions,
      migration004CodingSessions,
      migration005AiProviders
    ]),
    5
  )
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{}', 1)")
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec(
    "INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-4o', 1, 1)"
  )
}

describe('migration 6 (message context)', () => {
  it('fresh DB migrates to v6', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('v5 database upgrades to v6', () => {
    const db = openFresh()
    try {
      seedV5(db)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('preserves all v5 tables and rows', () => {
    const db = openFresh()
    try {
      seedV5(db)
      assert.equal(runMigrations(db, migrations), 17)
      for (const table of [
        'key_value',
        'workspaces',
        'change_transactions',
        'coding_sessions',
        'coding_messages',
        'ai_provider_configs'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates the context table with its message index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'message_context_items'))
      assert.ok(indexExists(db, 'idx_message_context_message_id'))
    } finally {
      db.close()
    }
  })

  it('enforces the kind CHECK and the message foreign key', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 't', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec(
        "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
          "VALUES (1, 'manual-note', 'Note', NULL, NULL, NULL, 'hi', 2, 1)"
      )
      assert.throws(() =>
        db.exec(
          "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
            "VALUES (1, 'tool-call', 'x', NULL, NULL, NULL, 'x', 1, 1)"
        )
      )
      assert.throws(() =>
        db.exec(
          "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
            "VALUES (999, 'manual-note', 'x', NULL, NULL, NULL, 'x', 1, 1)"
        )
      )
    } finally {
      db.close()
    }
  })

  it('cascades context rows when the message is deleted', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 't', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec(
        "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
          "VALUES (1, 'manual-note', 'Note', NULL, NULL, NULL, 'hi', 2, 1)"
      )
      db.exec('DELETE FROM coding_messages WHERE id = 1')
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM message_context_items').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning v6 is idempotent and keeps context rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 't', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec(
        "INSERT INTO message_context_items (message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) " +
          "VALUES (1, 'manual-note', 'Note', NULL, NULL, NULL, 'hi', 2, 1)"
      )
      assert.equal(runMigrations(db, migrations), 17)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM message_context_items').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v6 migration rolls back without marking version 6', () => {
    const db = openFresh()
    try {
      seedV5(db)
      const failingV6: Migration = {
        version: 6,
        name: 'broken-context',
        up(target): void {
          target.exec('CREATE TABLE message_context_items (id INTEGER PRIMARY KEY)')
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
            failingV6
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 5)
      assert.equal(tableExists(db, 'message_context_items'), false)
    } finally {
      db.close()
    }
  })

  it('migration 6 is registered after migration 5', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    )
    assert.equal(migration006MessageContext.version, 6)
  })
})
