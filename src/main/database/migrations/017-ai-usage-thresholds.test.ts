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
import { migration015ProjectRuntimes } from './015-project-runtimes'
import { migration016RuntimeObservationCapabilities } from './016-runtime-observation-capabilities'
import { migration017AiUsageThresholds } from './017-ai-usage-thresholds'

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

const V16: readonly Migration[] = [
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
  migration013WorkerTools,
  migration014WorkerCommandExecutions,
  migration015ProjectRuntimes,
  migration016RuntimeObservationCapabilities
]

function seedV16(db: DatabaseSync): void {
  assert.equal(runMigrations(db, V16), 16)
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
      "VALUES (1, 'workspace.read', 'allow', 1, 1)"
  )
  db.exec(
    "INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) " +
      "VALUES (1, 1, 1, 'running', 1, 1)"
  )
  db.exec('INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (1, 1, 1, \'terminal_execute\', \'terminal.execute\', \'{}\', \'h\', \'s\', \'pending\', 1)')
  db.exec('INSERT INTO worker_tool_events (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, result_summary, result_payload, result_bytes, status, created_at) VALUES (1, 1, 1, \'workspace_read\', \'workspace.read\', \'{}\', \'s\', \'{}\', 2, \'succeeded\', 1)')
  db.exec('INSERT INTO worker_tool_run_state (orchestration_run_id, tool_call_count, worker_instruction, active_user_message_id, continuity_used, state_json, state_hash, updated_at) VALUES (1, 1, \'i\', 1, 0, \'{}\', \'h\', 1)')
  db.exec(
    'INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, ' +
      "program, arguments_json, arguments_hash, preview_port, status, stdout_tail, stderr_tail, logs_truncated, " +
      "total_output_bytes, created_at, updated_at) VALUES (1, 1, 1, 1, 'npm', '{}', 'h', 5173, 'running', '', '', 0, 0, 1, 1)"
  )
}

describe('migration 17 (ai usage thresholds)', () => {
  it('fresh DB migrates to v17', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(getUserVersion(db), 18)
    } finally {
      db.close()
    }
  })

  it('v16 database upgrades to v17', () => {
    const db = openFresh()
    try {
      seedV16(db)
      assert.equal(runMigrations(db, migrations), 18)
      assert.equal(getUserVersion(db), 18)
    } finally {
      db.close()
    }
  })

  it('preserves all v16 data including capabilities, runtimes, and approvals', () => {
    const db = openFresh()
    try {
      seedV16(db)
      assert.equal(runMigrations(db, migrations), 18)
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
        'workspace_capability_policies',
        'orchestration_runs',
        'project_runtime_sessions'
      ]) {
        const count: unknown = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }), table)
      }
    } finally {
      db.close()
    }
  })

  it('creates usage tables, indexes, and defaults threshold routing OFF', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      for (const table of [
        'ai_usage_events',
        'ai_usage_settings',
        'ai_usage_limits',
        'ai_heart_threshold_alternates',
        'ai_usage_route_decisions'
      ]) {
        assert.ok(tableExists(db, table), table)
      }
      assert.ok(indexExists(db, 'idx_ai_usage_provider_model_created'))
      assert.ok(indexExists(db, 'idx_ai_usage_run'))
      // No seeded config: absent settings read as routing OFF.
      const settings: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_usage_settings').get()
      assert.equal(JSON.stringify(settings), JSON.stringify({ n: 0 }))
      const limits: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_usage_limits').get()
      assert.equal(JSON.stringify(limits), JSON.stringify({ n: 0 }))
      const alternates: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_heart_threshold_alternates').get()
      assert.equal(JSON.stringify(alternates), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('enforces workspace/session/run FKs with SET NULL on usage events', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() =>
        db.exec("INSERT INTO ai_usage_events (provider_id, model, operation, workspace_id, session_id, orchestration_run_id, status, created_at) VALUES ('openai', 'm', 'ask', 999, 999, 999, 'success', 1)")
      )
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, 'running', 1, 1)")
      db.exec("INSERT INTO ai_usage_events (provider_id, model, operation, workspace_id, session_id, orchestration_run_id, status, created_at) VALUES ('openai', 'm', 'ask', 1, 1, 1, 'success', 1)")
      db.exec('DELETE FROM workspaces WHERE id = 1')
      const event: unknown = db.prepare('SELECT workspace_id, session_id, orchestration_run_id FROM ai_usage_events WHERE id = 1').get()
      assert.equal(JSON.stringify(event), JSON.stringify({ workspace_id: null, session_id: null, orchestration_run_id: null }))
    } finally {
      db.close()
    }
  })

  it('enforces run CASCADE plus UNIQUE(run, role) on route decisions', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'a', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, 'running', 1, 1)")
      db.exec(
        "INSERT INTO ai_usage_route_decisions (orchestration_run_id, role, route_key, base_provider_id, base_model, " +
          "selected_provider_id, selected_model, decision, calls_24h, token_telemetry_complete, calls_triggered, " +
          "tokens_triggered, snapshot_at, created_at) VALUES (1, 'brain', 'brain.primary', 'openai', 'a', 'openai', 'x', 'base', 0, 1, 0, 0, 1, 1)"
      )
      assert.throws(() =>
        db.exec(
          "INSERT INTO ai_usage_route_decisions (orchestration_run_id, role, route_key, base_provider_id, base_model, " +
            "selected_provider_id, selected_model, decision, calls_24h, token_telemetry_complete, calls_triggered, " +
            "tokens_triggered, snapshot_at, created_at) VALUES (1, 'brain', 'brain.primary', 'openai', 'a', 'openai', 'y', 'base', 0, 1, 0, 0, 1, 1)"
        )
      )
      db.exec('DELETE FROM orchestration_runs WHERE id = 1')
      const remaining: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_usage_route_decisions').get()
      assert.equal(JSON.stringify(remaining), JSON.stringify({ n: 0 }))
    } finally {
      db.close()
    }
  })

  it('rerunning v17 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO ai_usage_limits (provider_id, model, max_calls_24h, max_total_tokens_24h, switch_at_percent, created_at, updated_at) VALUES ('openai', 'm', 10, NULL, 90, 1, 1)")
      assert.equal(runMigrations(db, migrations), 18)
      const count: unknown = db.prepare('SELECT COUNT(*) AS n FROM ai_usage_limits').get()
      assert.equal(JSON.stringify(count), JSON.stringify({ n: 1 }))
    } finally {
      db.close()
    }
  })

  it('a failing v17 migration rolls back with user_version staying v16', () => {
    const db = openFresh()
    try {
      seedV16(db)
      const failingV17: Migration = {
        version: 17,
        name: 'broken-ai-usage',
        up(target): void {
          target.exec('CREATE TABLE ai_usage_events (id INTEGER PRIMARY KEY)')
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
            migration012AgentCapabilities,
            migration013WorkerTools,
            migration014WorkerCommandExecutions,
            migration015ProjectRuntimes,
            migration016RuntimeObservationCapabilities,
            failingV17
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 16)
      assert.equal(tableExists(db, 'ai_usage_events'), false)
    } finally {
      db.close()
    }
  })

  it('migration 17 is registered after migration 16', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
    )
    assert.equal(migration017AiUsageThresholds.version, 17)
  })
})
