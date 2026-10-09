import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { getUserVersion, migrations, runMigrations } from './migrations/index'

/**
 * Upgrade matrix (Stage 30): representative historical boundaries all
 * land on v18 with era data preserved. No full Cartesian matrix —
 * fresh plus the provider-config (v5), Heart (v9), Worker-tool (v13),
 * managed-runtime (v15), and usage (v17) eras.
 */
function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function seedBaseEra(db: DatabaseSync, tag: string): void {
  db.exec(
    `INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings.${tag}', '{"a":1}', 1)`
  )
  db.exec(
    `INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) ` +
      `VALUES ('/proj/${tag}', '${tag}', 1, 1)`
  )
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as Record<string, unknown>
  return row['n'] as number
}

describe('upgrade matrix to v18', () => {
  it('fresh install lands on v18 with cloud tables', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(getUserVersion(db), 18)
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Record<
          string,
          unknown
        >[]
      ).map((row) => String(row['name']))
      for (const expected of ['key_value', 'workspaces', 'cloud_account', 'cloud_auth_session']) {
        assert.ok(tables.includes(expected), `missing ${expected}`)
      }
    } finally {
      db.close()
    }
  })

  it('v5 provider-config era upgrades to v18 preserving rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations.filter((migration) => migration.version <= 5)), 5)
      seedBaseEra(db, 'v5')
      db.exec(
        "INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) " +
          "VALUES ('openai', 'gpt-4o', 1, 1)"
      )
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(count(db, 'workspaces'), 1)
      const config = db
        .prepare('SELECT selected_model FROM ai_provider_configs WHERE provider_id = ?')
        .get('openai') as unknown as Record<string, unknown>
      assert.equal(config['selected_model'], 'gpt-4o')
    } finally {
      db.close()
    }
  })

  it('v9 Heart era upgrades to v18 preserving rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations.filter((migration) => migration.version <= 9)), 9)
      seedBaseEra(db, 'v9')
      db.exec(
        "INSERT INTO ai_heart_settings (id, worker_mode, created_at, updated_at) VALUES (1, 'fixed', 1, 1)"
      )
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(count(db, 'workspaces'), 1)
      assert.equal(count(db, 'ai_heart_settings'), 1)
    } finally {
      db.close()
    }
  })

  it('v13 Worker-tool era upgrades to v18 preserving rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations.filter((migration) => migration.version <= 13)), 13)
      seedBaseEra(db, 'v13')
      db.exec(
        `INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) ` +
          `VALUES (1, 'era session', 1, 1)`
      )
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(count(db, 'workspaces'), 1)
      assert.equal(count(db, 'coding_sessions'), 1)
    } finally {
      db.close()
    }
  })

  it('v15 managed-runtime era upgrades to v18 preserving rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations.filter((migration) => migration.version <= 15)), 15)
      seedBaseEra(db, 'v15')
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(count(db, 'workspaces'), 1)
      const row = db
        .prepare("SELECT value FROM key_value WHERE key = 'stark.settings.v15'")
        .get() as unknown as Record<string, unknown>
      assert.equal(row['value'], '{"a":1}')
    } finally {
      db.close()
    }
  })

  it('v17 usage era upgrades to v18 preserving rows', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations.filter((migration) => migration.version <= 17)), 17)
      seedBaseEra(db, 'v17')
      db.exec(
        'INSERT INTO ai_usage_settings (id, heart_threshold_routing_enabled, created_at, updated_at) ' +
          'VALUES (1, 0, 1, 1)'
      )
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(count(db, 'workspaces'), 1)
      assert.equal(count(db, 'ai_usage_settings'), 1)
      assert.equal(count(db, 'cloud_account'), 0)
    } finally {
      db.close()
    }
  })
})
