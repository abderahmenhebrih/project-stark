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
import { migration011RecoveryContinuity } from './011-recovery-continuity'
import { migration012AgentCapabilities } from './012-agent-capabilities'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

function seedV11(db: DatabaseSync): void {
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
      migration009Heart,
      migration010Looplink,
      migration011RecoveryContinuity
    ]),
    11
  )
  db.exec("INSERT INTO key_value (key, value, updated_at) VALUES ('stark.settings', '{}', 1)")
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO change_transactions (workspace_id, status, created_at, updated_at) VALUES (1, 'pending', 1, 1)")
  db.exec(
    "INSERT INTO change_sets (workspace_id, kind, summary, created_at, updated_at) VALUES (1, 'ai_multi_file_proposal', 's', 1, 1)"
  )
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec("INSERT INTO ai_heart_settings (id, worker_mode, created_at, updated_at) VALUES (1, 'fixed', 1, 1)")
  db.exec(
    "INSERT INTO ai_provider_configs (provider_id, selected_model, created_at, updated_at) VALUES ('openai', 'gpt-4o', 1, 1)"
  )
  db.exec(
    'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, status, payload, ' +
      "payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, " +
      "omitted_change_count, created_at) VALUES (1, 1, 1, 'pending', '{}', 2, 'x', 0, 0, 0, 0, 1)"
  )
  db.exec(
    "INSERT INTO ai_recovery_settings (id, mode, created_at, updated_at) VALUES (1, 'off', 1, 1)"
  )
}

describe('migration 12 (agent capabilities)', () => {
  it('fresh DB migrates to v12', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
    } finally {
      db.close()
    }
  })

  it('v11 database upgrades to v12', () => {
    const db = openFresh()
    try {
      seedV11(db)
      assert.equal(runMigrations(db, migrations), 19)
      assert.equal(getUserVersion(db), 19)
    } finally {
      db.close()
    }
  })

  it('preserves all v11 data including Recovery and Looplink', () => {
    const db = openFresh()
    try {
      seedV11(db)
      assert.equal(runMigrations(db, migrations), 19)
      for (const table of [
        'key_value',
        'workspaces',
        'change_transactions',
        'change_sets',
        'coding_sessions',
        'coding_messages',
        'ai_heart_settings',
        'ai_provider_configs',
        'looplink_handoffs',
        'ai_recovery_settings'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates capability tables', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'workspace_agent_settings'))
      assert.ok(tableExists(db, 'workspace_capability_policies'))
    } finally {
      db.close()
    }
  })

  it('enforces workspace FK cascade', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec('INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (999, 0, 1, 1)')
      )
      assert.throws(() =>
        db.exec("INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) VALUES (999, 'workspace.read', 'allow', 1, 1)")
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec('INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (1, 1, 1, 1)')
      db.exec("INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) VALUES (1, 'workspace.read', 'allow', 1, 1)")
      db.exec('DELETE FROM workspaces WHERE id = 1')
      const settings: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspace_agent_settings').get()
      assert.equal(JSON.stringify(settings), JSON.stringify({ n: 0 }))
      const policies: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspace_capability_policies').get()
      assert.equal(JSON.stringify(policies), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning v12 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec('INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (1, 0, 1, 1)')
      assert.equal(runMigrations(db, migrations), 19)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM workspace_agent_settings').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v12 migration rolls back with user_version staying v11', () => {
    const db = openFresh()
    try {
      seedV11(db)
      const failingV12: Migration = {
        version: 12,
        name: 'broken-capabilities',
        up(target): void {
          target.exec('CREATE TABLE workspace_agent_settings (workspace_id INTEGER PRIMARY KEY)')
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
            migration010Looplink,
            migration011RecoveryContinuity,
            failingV12
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 11)
      assert.equal(tableExists(db, 'workspace_agent_settings'), false)
    } finally {
      db.close()
    }
  })

  it('migration 12 is registered after migration 11', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    )
    assert.equal(migration012AgentCapabilities.version, 12)
  })

  it('migrations 001-011 are unchanged (v11 seed still applies cleanly)', () => {
    const db = openFresh()
    try {
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
          migration009Heart,
          migration010Looplink,
          migration011RecoveryContinuity
        ]),
        11
      )
    } finally {
      db.close()
    }
  })
})
