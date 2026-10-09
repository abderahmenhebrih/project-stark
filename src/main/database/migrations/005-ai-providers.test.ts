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

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return row !== undefined
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows: unknown = db.prepare(`PRAGMA table_info(${table})`).all()
  assert.ok(Array.isArray(rows))
  return rows.map((row) => (row as Record<string, unknown>)['name'] as string)
}

function seedV4(db: DatabaseSync): void {
  assert.equal(
    runMigrations(db, [migration001Initial, migration002Workspaces, migration003ChangeTransactions, migration004CodingSessions]),
    4
  )
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{}', 1)")
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
}

describe('migration 5 (AI providers)', () => {
  it('fresh DB migrates through v6 with provider tables', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('v4 database upgrades through v6', () => {
    const db = openFresh()
    try {
      seedV4(db)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('preserves all v4 tables and rows through v6', () => {
    const db = openFresh()
    try {
      seedV4(db)
      assert.equal(runMigrations(db, migrations), 17)
      for (const table of ['key_value', 'workspaces', 'change_transactions', 'coding_sessions', 'coding_messages']) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates the provider config table', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'ai_provider_configs'))
    } finally {
      db.close()
    }
  })

  it('creates the credential table with a BLOB column', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'ai_provider_credentials'))
      const row: unknown = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ai_provider_credentials'").get()
      assert.ok(JSON.stringify(row).includes('BLOB'))
    } finally {
      db.close()
    }
  })

  it('round-trips ciphertext bytes exactly', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      const now = 1000
      db.exec(`INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', NULL, ${now}, ${now})`)
      const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64])
      db.prepare('INSERT INTO ai_provider_credentials (provider_id, encrypted_api_key, updated_at) VALUES (?, ?, ?)').run(
        'openai',
        bytes,
        now
      )
      const row: unknown = db.prepare('SELECT encrypted_api_key FROM ai_provider_credentials WHERE provider_id = ?').get('openai')
      assert.ok(row !== undefined)
      const stored = (row as Record<string, unknown>)['encrypted_api_key']
      assert.ok(stored instanceof Uint8Array)
      assert.deepEqual(Buffer.from(stored), bytes)
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys between credential and config rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec("INSERT INTO ai_provider_credentials (provider_id, encrypted_api_key, updated_at) VALUES ('ghost', x'00', 1)")
      )
      db.exec("INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', NULL, 1, 1)")
      db.exec("INSERT INTO ai_provider_credentials (provider_id, encrypted_api_key, updated_at) VALUES ('openai', x'00', 1)")
      db.exec("DELETE FROM ai_provider_configs WHERE provider_id = 'openai'")
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_provider_credentials').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning through v6 is idempotent and keeps provider rows', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-x', 1, 1)")
      assert.equal(runMigrations(db, migrations), 17)
      const row: unknown = db.prepare('SELECT selected_model FROM ai_provider_configs WHERE provider_id = ?').get('openai')
      assert.equal(JSON.stringify(row), JSON.stringify({ selected_model: 'gpt-x' }))
    } finally {
      db.close()
    }
  })

  it('a failing v5 migration rolls back without marking version 5', () => {
    const db = openFresh()
    try {
      seedV4(db)
      const failingV5: Migration = {
        version: 5,
        name: 'broken-providers',
        up(target): void {
          target.exec('CREATE TABLE ai_provider_configs (provider_id TEXT PRIMARY KEY)')
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
            failingV5
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 4)
      assert.equal(tableExists(db, 'ai_provider_configs'), false)
    } finally {
      db.close()
    }
  })

  it('stores no plaintext credential column anywhere', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      for (const table of ['ai_provider_configs', 'ai_provider_credentials']) {
        const columns = columnNames(db, table)
        for (const forbidden of ['api_key', 'plaintext', 'secret', 'token']) {
          assert.ok(!columns.includes(forbidden), `${table} must not contain ${forbidden}`)
        }
      }
      assert.ok(columnNames(db, 'ai_provider_credentials').includes('encrypted_api_key'))
    } finally {
      db.close()
    }
  })

  it('migration 5 remains registered before migration 6', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    )
    assert.equal(migration005AiProviders.version, 5)
  })
})
