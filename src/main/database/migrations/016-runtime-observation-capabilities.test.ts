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

function openFresh(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

const V15: readonly Migration[] = [
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
  migration015ProjectRuntimes
]

function seedV15WithFiveCaps(db: DatabaseSync): void {
  assert.equal(runMigrations(db, V15), 15)
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec('INSERT INTO workspace_agent_settings (workspace_id, enabled, created_at, updated_at) VALUES (1, 1, 1, 1)')
  for (const [capability, mode] of [
    ['workspace.read', 'allow'],
    ['workspace.search', 'ask'],
    ['git.read', 'allow'],
    ['change.propose', 'ask'],
    ['terminal.execute', 'deny']
  ] as const) {
    db.exec(
      `INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) VALUES (1, '${capability}', '${mode}', 1, 1)`
    )
  }
}

function policiesFor(db: DatabaseSync, workspaceId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT capability, mode FROM workspace_capability_policies WHERE workspace_id = ?')
    .all(workspaceId) as { capability: string; mode: string }[]
  return new Map(rows.map((row) => [row.capability, row.mode]))
}

describe('migration 16 (runtime observation capabilities)', () => {
  it('fresh DB migrates to v17', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('v15 database upgrades to v17', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, V15), 15)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(getUserVersion(db), 17)
    } finally {
      db.close()
    }
  })

  it('backfills the two new capabilities as deny without modifying existing policies', () => {
    const db = openFresh()
    try {
      seedV15WithFiveCaps(db)
      assert.equal(runMigrations(db, migrations), 17)
      const policies = policiesFor(db, 1)
      assert.equal(policies.size, 7)
      assert.equal(policies.get('workspace.read'), 'allow')
      assert.equal(policies.get('workspace.search'), 'ask')
      assert.equal(policies.get('git.read'), 'allow')
      assert.equal(policies.get('change.propose'), 'ask')
      assert.equal(policies.get('terminal.execute'), 'deny')
      assert.equal(policies.get('runtime.observe'), 'deny')
      assert.equal(policies.get('preview.inspect'), 'deny')
    } finally {
      db.close()
    }
  })

  it('is idempotent and creates no duplicate rows', () => {
    const db = openFresh()
    try {
      seedV15WithFiveCaps(db)
      assert.equal(runMigrations(db, migrations), 17)
      assert.equal(runMigrations(db, migrations), 17)
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM workspace_capability_policies WHERE workspace_id = 1')
        .get() as { n: number }
      assert.equal(count.n, 7)
    } finally {
      db.close()
    }
  })

  it('leaves unconfigured workspaces unconfigured (synthesized default-deny)', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, V15), 15)
      db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
      assert.equal(runMigrations(db, migrations), 17)
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM workspace_capability_policies WHERE workspace_id = 1')
        .get() as { n: number }
      assert.equal(count.n, 0)
      const settings = db.prepare('SELECT COUNT(*) AS n FROM workspace_agent_settings WHERE workspace_id = 1').get() as {
        n: number
      }
      assert.equal(settings.n, 0)
    } finally {
      db.close()
    }
  })

  it('a failing v16 migration rolls back with user_version staying v15', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, V15), 15)
      const failingV16: Migration = {
        version: 16,
        name: 'broken-runtime-observation',
        up(target): void {
          target.exec("INSERT INTO workspace_capability_policies (workspace_id, capability, mode, created_at, updated_at) VALUES (999, 'x', 'deny', 1, 1)")
          throw new Error('boom after write')
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
            failingV16
          ]),
        MigrationError
      )
      assert.equal(getUserVersion(db), 15)
    } finally {
      db.close()
    }
  })

  it('migration 16 is registered after migration 15', () => {
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    )
    assert.equal(migration016RuntimeObservationCapabilities.version, 16)
  })

  it('migrations 001-015 are unchanged (v15 seed still applies cleanly)', () => {
    const db = openFresh()
    try {
      assert.equal(runMigrations(db, V15), 15)
    } finally {
      db.close()
    }
  })
})
