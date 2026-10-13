import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
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
import { migration018CloudAccount } from './018-cloud-account'
import { migration019MessageAttachments } from './019-message-attachments'

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

function seedV19(db: DatabaseSync): void {
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
      migration011RecoveryContinuity,
      migration012AgentCapabilities,
      migration013WorkerTools,
      migration014WorkerCommandExecutions,
      migration015ProjectRuntimes,
      migration016RuntimeObservationCapabilities,
      migration017AiUsageThresholds,
      migration018CloudAccount,
      migration019MessageAttachments
    ]),
    19
  )
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec(
    'INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) ' +
      "VALUES (1, 1, 1, 'completed', 1, 1)"
  )
  db.exec(
    'INSERT INTO orchestration_steps (run_id, ordinal, kind, status, created_at, updated_at) ' +
      "VALUES (1, 0, 'brain_plan', 'completed', 1, 1)"
  )
  db.exec(
    "INSERT INTO orchestration_step_models (step_id, role, provider_id, model, route_key, requested_profile) " +
      "VALUES (1, 'brain', 'openai', 'gpt-4o', 'primary', NULL)"
  )
}

describe('migration 20 (looplink-audit)', () => {
  it('fresh database migrates to schema version 20', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 20)
      assert.equal(getUserVersion(db), 20)
    } finally {
      db.close()
    }
  })

  it('v19 database upgrades to v20 with step audits intact', () => {
    const db = openFresh()
    try {
      seedV19(db)
      assert.equal(runMigrations(db, migrations), 20)
      assert.equal(getUserVersion(db), 20)
      const row: unknown = db
        .prepare(
          'SELECT step_id, role, provider_id, model, route_key, requested_profile, attempts, failover_note, ' +
            'attempted_models, requested_chain, requested_effort FROM orchestration_step_models WHERE step_id = 1'
        )
        .get()
      assert.equal(
        JSON.stringify(row),
        JSON.stringify({
          step_id: 1,
          role: 'brain',
          provider_id: 'openai',
          model: 'gpt-4o',
          route_key: 'primary',
          requested_profile: null,
          attempts: null,
          failover_note: null,
          attempted_models: null,
          requested_chain: null,
          requested_effort: null
        })
      )
    } finally {
      db.close()
    }
  })

  it('new audit columns accept bounded LoopLink metadata', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 'New session', 1, 1)")
      db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
      db.exec(
        'INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) ' +
          "VALUES (1, 1, 1, 'completed', 1, 1)"
      )
      db.exec(
        'INSERT INTO orchestration_steps (run_id, ordinal, kind, status, created_at, updated_at) ' +
          "VALUES (1, 0, 'brain_plan', 'completed', 1, 1)"
      )
      db.exec(
        'INSERT INTO orchestration_step_models ' +
          '(step_id, role, provider_id, model, route_key, requested_profile, attempts, failover_note, ' +
          'attempted_models, requested_chain, requested_effort) VALUES (1, ' +
          "'brain', 'stark', 'builtin:deepseek-v4.1-flash', 'primary', NULL, 2, " +
          "'Switched to builtin:deepseek-v4.1-flash after builtin:gpt-5.6-luna was unavailable.', " +
          '\'["builtin:gpt-5.6-luna","builtin:deepseek-v4.1-flash"]\', ' +
          '\'["builtin:gpt-5.6-luna","builtin:deepseek-v4.1-flash"]\', \'high\')'
      )
      const row = db
        .prepare('SELECT attempts, failover_note, attempted_models, requested_chain, requested_effort FROM orchestration_step_models WHERE step_id = 1')
        .get() as Record<string, unknown>
      assert.equal(row['attempts'], 2)
      assert.equal(typeof row['failover_note'], 'string')
      assert.deepEqual(JSON.parse(row['attempted_models'] as string), [
        'builtin:gpt-5.6-luna',
        'builtin:deepseek-v4.1-flash'
      ])
    } finally {
      db.close()
    }
  })

  it('rerunning v20 is idempotent', () => {
    const db = openFresh()
    try {
      runMigrations(db, migrations)
      assert.equal(runMigrations(db, migrations), 20)
      assert.equal(getUserVersion(db), 20)
    } finally {
      db.close()
    }
  })
})
