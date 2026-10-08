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

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return row !== undefined
}

function seedV8(db: DatabaseSync): void {
  assert.equal(
    runMigrations(db, [
      migration001Initial,
      migration002Workspaces,
      migration003ChangeTransactions,
      migration004CodingSessions,
      migration005AiProviders,
      migration006MessageContext,
      migration007ChangeSets,
      migration008OrchestrationRuns
    ]),
    8
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

describe('migration 9 (heart)', () => {
  it('fresh DB migrates to v9', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 13)
      assert.equal(getUserVersion(db), 13)
    } finally {
      db.close()
    }
  })

  it('v8 database upgrades to v9', () => {
    const db = openFresh()
    try {
      seedV8(db)
      assert.equal(runMigrations(db, migrations), 13)
      assert.equal(getUserVersion(db), 13)
    } finally {
      db.close()
    }
  })

  it('preserves all v8 tables and rows', () => {
    const db = openFresh()
    try {
      seedV8(db)
      assert.equal(runMigrations(db, migrations), 13)
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

  it('creates the heart tables', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'ai_heart_settings'))
      assert.ok(tableExists(db, 'ai_heart_assignments'))
      assert.ok(tableExists(db, 'orchestration_step_models'))
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys on step audit rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec(
          "INSERT INTO orchestration_step_models (step_id, role, provider_id, model, route_key, requested_profile) " +
            "VALUES (999, 'brain', 'openai', 'm', 'primary', NULL)"
        )
      )
    } finally {
      db.close()
    }
  })

  it('rerunning v9 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec(
        "INSERT INTO ai_heart_settings (id, worker_mode, created_at, updated_at) VALUES (1, 'fixed', 1, 1)"
      )
      assert.equal(runMigrations(db, migrations), 13)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_heart_settings').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v9 migration rolls back with user_version staying v8', () => {
    const db = openFresh()
    try {
      seedV8(db)
      const failingV9: Migration = {
        version: 9,
        name: 'broken-heart',
        up(target): void {
          target.exec('CREATE TABLE ai_heart_settings (id INTEGER PRIMARY KEY)')
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
            failingV9
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 8)
      assert.equal(tableExists(db, 'ai_heart_assignments'), false)
    } finally {
      db.close()
    }
  })

  it('migration 9 is registered after migration 8', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    )
    assert.equal(migration009Heart.version, 9)
  })
})
