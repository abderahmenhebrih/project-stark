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
import { migration008OrchestrationRuns } from './008-orchestration-runs'
import { migration009Heart } from './009-heart'
import { migration010Looplink } from './010-looplink'

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

function seedV9(db: DatabaseSync): void {
  assert.equal(
    runMigrations(db, [
      migration001Initial,
      migration002Workspaces,
      migration003ChangeTransactions,
      migration004CodingSessions,
      migration005AiProviders,
      migration006MessageContext,
      migration007ChangeSets,
      migration008OrchestrationRuns,
      migration009Heart
    ]),
    9
  )
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{}', 1)")
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
  db.exec(
    "INSERT INTO change_sets (workspace_id, kind, summary, created_at, updated_at) VALUES (1, 'ai_multi_file_proposal', 's', 1, 1)"
  )
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec(
    "INSERT INTO ai_heart_settings (id, worker_mode, created_at, updated_at) VALUES (1, 'fixed', 1, 1)"
  )
  db.exec(
    "INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-4o', 1, 1)"
  )
}

describe('migration 10 (looplink)', () => {
  it('fresh DB migrates to v10', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('v9 database upgrades to v10', () => {
    const db = openFresh()
    try {
      seedV9(db)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('preserves all v9 data including Heart settings and Change Sets', () => {
    const db = openFresh()
    try {
      seedV9(db)
      assert.equal(runMigrations(db, migrations), 17)
      for (const table of [
        'key_value',
        'workspaces',
        'change_transactions',
        'change_sets',
        'coding_sessions',
        'coding_messages',
        'ai_heart_settings',
        'ai_provider_configs'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates the handoff table with the source index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'looplink_handoffs'))
      assert.ok(indexExists(db, 'idx_looplink_source_created'))
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys and the unique target session', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec(
          'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
            'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
            "omitted_change_count, created_at) VALUES (999, 1, 2, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 1)"
        )
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'b', 1, 1)")
      db.exec(
        'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
          'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
          "omitted_change_count, created_at) VALUES (1, 1, 2, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 1)"
      )
      assert.throws(() =>
        db.exec(
          'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
            'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
            "omitted_change_count, created_at) VALUES (1, 1, 2, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 2)"
        )
      )
    } finally {
      db.close()
    }
  })

  it('rerunning v10 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'b', 1, 1)")
      db.exec(
        'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
          'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
          "omitted_change_count, created_at) VALUES (1, 1, 2, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 1)"
      )
      assert.equal(runMigrations(db, migrations), 17)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM looplink_handoffs').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v10 migration rolls back with user_version staying v9', () => {
    const db = openFresh()
    try {
      seedV9(db)
      const failingV10: Migration = {
        version: 10,
        name: 'broken-looplink',
        up(target): void {
          target.exec('CREATE TABLE looplink_handoffs (id INTEGER PRIMARY KEY)')
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
            migration007ChangeSets,
            migration008OrchestrationRuns,
            migration009Heart,
            failingV10
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 9)
      assert.equal(tableExists(db, 'looplink_handoffs'), false)
    } finally {
      db.close()
    }
  })

  it('migration 10 is registered after migration 9', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    )
    assert.equal(migration010Looplink.version, 10)
  })
})
