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
import { migration013WorkerTools } from './013-worker-tools'
import { migration014WorkerCommandExecutions } from './014-worker-command-executions'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

function indexExists(db: DatabaseSync, name: string): boolean {
  const row: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
  return row !== undefined
}

const V13: readonly Migration[] = [
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
  migration012AgentCapabilities,
  migration013WorkerTools
]

function seedV13(db: DatabaseSync): void {
  assert.equal(runMigrations(db, V13), 13)
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
  db.exec("INSERT INTO ai_recovery_settings (id, mode, created_at, updated_at) VALUES (1, 'off', 1, 1)")
  db.exec('INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (1, 1, 1, 1)')
  db.exec(
    "INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) " +
      "VALUES (1, 'terminal.execute', 'ask', 1, 1)"
  )
  db.exec('INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, \'running\', 1, 1)')
  db.exec('INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (1, 1, 1, \'terminal_execute\', \'terminal.execute\', \'{}\', \'h\', \'s\', \'pending\', 1)')
  db.exec('INSERT INTO worker_tool_events (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, result_summary, result_payload, result_bytes, status, created_at) VALUES (1, 1, 1, \'workspace_read\', \'workspace.read\', \'{}\', \'s\', \'{}\', 2, \'succeeded\', 1)')
  db.exec('INSERT INTO worker_tool_run_state (orchestration_run_id, tool_call_count, worker_instruction, active_user_message_id, continuity_used, state_json, state_hash, updated_at) VALUES (1, 1, \'i\', 1, 0, \'{}\', \'h\', 1)')
}

describe('migration 14 (worker command executions)', () => {
  it('fresh DB migrates to v17', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('v13 database upgrades to v17', () => {
    const db = openFresh()
    try {
      seedV13(db)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('preserves all v13 data including approvals, events, and run state', () => {
    const db = openFresh()
    try {
      seedV13(db)
      assert.equal(runMigrations(db, migrations), 17)
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
        'ai_recovery_settings',
        'workspace_agent_settings',
        'orchestration_runs',
        'worker_tool_approvals',
        'worker_tool_events',
        'worker_tool_run_state'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
      // Stage 27 backfills two default-deny observation policies alongside
      // the one seeded v13 row; the original row is preserved verbatim.
      // Raw rows use null prototypes, so compare serialized forms.
      const policies = db
        .prepare('SELECT capability, mode FROM workspace_capability_policies WHERE workspace_id = 1 ORDER BY capability')
        .all() as { capability: string; mode: string }[]
      assert.equal(
        JSON.stringify(policies),
        JSON.stringify([
          { capability: 'preview.inspect', mode: 'deny' },
          { capability: 'runtime.observe', mode: 'deny' },
          { capability: 'terminal.execute', mode: 'ask' }
        ])
      )
    } finally {
      db.close()
    }
  })

  it('creates the executions table with the run index', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.ok(tableExists(db, 'worker_command_executions'))
      assert.ok(indexExists(db, 'idx_worker_command_run_created'))
    } finally {
      db.close()
    }
  })

  it('enforces the UNIQUE approval reservation', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec('INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, \'running\', 1, 1)')
      db.exec('INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (1, 1, 1, \'terminal_execute\', \'terminal.execute\', \'{}\', \'h\', \'s\', \'pending\', 1)')
      db.exec('INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, status, stdout, stderr, output_bytes, truncated, created_at) VALUES (1, 1, 1, 1, \'node\', \'[]\', \'h\', \'completed\', \'\', \'\', 0, 0, 1)')
      assert.throws(() =>
        db.exec('INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, status, stdout, stderr, output_bytes, truncated, created_at) VALUES (1, 1, 1, 1, \'node\', \'[]\', \'h\', \'completed\', \'\', \'\', 0, 0, 1)')
      )
    } finally {
      db.close()
    }
  })

  it('enforces workspace/session/run/approval FK cascades', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec('INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, status, stdout, stderr, output_bytes, truncated, created_at) VALUES (999, 1, 1, 1, \'node\', \'[]\', \'h\', \'launching\', \'\', \'\', 0, 0, 1)')
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec('INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, \'running\', 1, 1)')
      db.exec('INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (1, 1, 1, \'terminal_execute\', \'terminal.execute\', \'{}\', \'h\', \'s\', \'pending\', 1)')
      db.exec('INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, status, stdout, stderr, output_bytes, truncated, created_at) VALUES (1, 1, 1, 1, \'node\', \'[]\', \'h\', \'completed\', \'\', \'\', 0, 0, 1)')
      db.exec('DELETE FROM workspaces WHERE id = 1')
      const remaining: unknown = db.prepare('SELECT COUNT(*) AS n FROM worker_command_executions').get()
      assert.equal(JSON.stringify(remaining), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning v17 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.equal(runMigrations(db, migrations), 17)
    } finally {
      db.close()
    }
  })

  it('a failing v14 migration rolls back with user_version staying v13', () => {
    const db = openFresh()
    try {
      seedV13(db)
      const failingV14: Migration = {
        version: 14,
        name: 'broken-command-executions',
        up(target): void {
          target.exec('CREATE TABLE worker_command_executions (id INTEGER PRIMARY KEY)')
          throw new Error('boom after ddl')
        }
      }
      assert.throws(() => runMigrations(db, [...V13, failingV14]), MigrationError)
      assert.equal(getUserVersion(db), 13)
      assert.equal(tableExists(db, 'worker_command_executions'), false)
    } finally {
      db.close()
    }
  })

  it('migration 14 is registered after migration 13', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    )
    assert.equal(migration014WorkerCommandExecutions.version, 14)
  })
})
