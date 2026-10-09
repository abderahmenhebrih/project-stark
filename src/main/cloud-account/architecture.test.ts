import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { migrations, runMigrations } from '../database/migrations/index'

function root(): string {
  return process.cwd()
}

function listFilesRecursive(dir: string, suffix: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.test-dist' || entry === 'out' || entry === 'dist' || entry === '.git') {
      continue
    }
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(full, suffix))
    } else if (full.endsWith(suffix)) {
      out.push(full)
    }
  }
  return out
}

function readSource(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('Stage 29 architecture boundaries', () => {
  it('cloud account domain imports no Workspace/session/sync/runtime/usage/AI modules', () => {
    const dir = join(root(), 'src', 'main', 'cloud-account')
    const files = listFilesRecursive(dir, '.ts').filter((file) => !file.endsWith('.test.ts'))
    assert.ok(files.length >= 7)
    const forbidden = [
      'WorkspaceFilesService',
      'WorkspaceFileWriteService',
      'WorkspaceRepository',
      'CodingSessionRepository',
      'ChangeTransactionRepository',
      'ChangeTransactionService',
      'ChangeSetService',
      'WorkerTool',
      'worker-tool',
      'ProjectRuntimeService',
      'project-runtime',
      'AiUsageService',
      'ai-usage',
      'AiProviderService',
      'ai-provider-service',
      'openai',
      'OpenAI',
      'HeartService',
      'BrainService',
      'LooplinkService',
      'RecoveryService',
      'CapabilityService'
    ]
    for (const file of files) {
      const source = readSource(file)
      for (const token of forbidden) {
        assert.ok(!source.includes(token), `${file} must not reference ${token}`)
      }
    }
  })

  it('renderer and preload never import Supabase', () => {
    for (const dir of [join(root(), 'src', 'renderer'), join(root(), 'src', 'preload')]) {
      const files = listFilesRecursive(dir, '.ts').concat(listFilesRecursive(dir, '.tsx'))
      for (const file of files) {
        const source = readSource(file)
        assert.ok(!source.includes('@supabase/supabase-js'), `${file} must not import Supabase`)
        assert.ok(!source.includes('supabase'), `${file} must not reference supabase`)
      }
    }
  })

  it('only the main Supabase adapter owns the Supabase client', () => {
    const mainFiles = listFilesRecursive(join(root(), 'src', 'main'), '.ts').filter(
      (file) => !file.endsWith('.test.ts')
    )
    const owners = mainFiles.filter((file) => readSource(file).includes('@supabase/supabase-js'))
    assert.equal(owners.length, 1)
    assert.ok(owners[0].endsWith('supabase-auth-adapter.ts'), `unexpected Supabase owner: ${owners[0]}`)
  })

  it('no service-role credential in client surfaces', () => {
    const surfaceFiles = listFilesRecursive(join(root(), 'src'), '.ts')
      .concat(listFilesRecursive(join(root(), 'src'), '.tsx'))
      .filter((file) => !file.endsWith('.test.ts'))
    for (const file of surfaceFiles) {
      const source = readSource(file)
      assert.ok(!source.includes('SUPABASE_SERVICE_ROLE'), `${file} must not reference a service-role env key`)
    }
    // Defensive rejection guard is the only allowed executable
    // mention of the service_role literal outside comments/docs.
    const offenderFiles = surfaceFiles.filter((file) => {
      const source = readSource(file)
      const lines = source.split('\n').filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('--')
      })
      return lines.join('\n').includes('service_role')
    })
    assert.ok(
      offenderFiles.length <= 1 && (offenderFiles.length === 0 || offenderFiles[0].endsWith('supabase-auth-adapter.ts')),
      `only the Supabase adapter guard may mention service_role: ${offenderFiles.join(',')}`
    )
  })

  it('cloud account domain has no auth polling, refresh loops, or retry backoff', () => {
    const dir = join(root(), 'src', 'main', 'cloud-account')
    const files = listFilesRecursive(dir, '.ts').filter((file) => !file.endsWith('.test.ts'))
    for (const file of files) {
      const source = readSource(file)
      assert.ok(!source.includes('setInterval'), `${file} must not poll`)
      assert.ok(!source.includes('setTimeout'), `${file} must not use timers`)
      assert.ok(!source.includes('pollAuth'), `${file} must not poll auth`)
      assert.ok(!source.includes('pollSession'), `${file} must not poll sessions`)
      assert.ok(!source.includes('refreshSession'), `${file} must not background-refresh`)
      assert.ok(!source.includes('backoff'), `${file} must not back off`)
      assert.ok(!source.includes('maxRetries'), `${file} must not configure retries`)
      assert.ok(!source.includes('while (true'), `${file} must not loop`)
      assert.ok(!source.includes('while(true'), `${file} must not loop`)
    }
    const attemptSource = readSource(join(dir, 'oauth-attempt-manager.ts'))
    assert.ok(attemptSource.includes('MAX_AUTH_ATTEMPT_MS'), 'attempt lifetime must be the bounded 5-minute constant')
  })

  it('no generic account openUrl endpoint and no renderer OAuth completion channel', () => {
    const values = Object.values(IPC_CHANNELS) as string[]
    assert.ok(!values.some((channel) => channel.includes('openUrl') || channel.includes('open-url')), 'no openUrl channel')
    assert.ok(!values.some((channel) => channel.includes('complete-oauth')), 'no OAuth completion channel')
    assert.ok(values.includes('stark:account:get-status'))
    assert.ok(values.includes('stark:account:start-sign-in'))
    assert.ok(values.includes('stark:account:cancel-sign-in'))
    assert.ok(values.includes('stark:account:sign-out'))
    assert.ok(values.includes('stark:account:updated'))
    const bindingsSource = readSource(join(root(), 'src', 'main', 'ipc', 'account.ts'))
    assert.ok(!bindingsSource.includes('openExternal'), 'account IPC must not open URLs')
    // Payload keys are provider-only: no secret-bearing property access.
    for (const access of ["['code']", "['token']", "['session']", "['oauthUrl']", "['accessToken']", "['refreshToken']", 'payload.code', 'payload.token']) {
      assert.ok(!bindingsSource.includes(access), `account IPC must not carry ${access}`)
    }
    const preloadSource = readSource(join(root(), 'src', 'preload', 'index.ts'))
    assert.ok(!preloadSource.includes('complete-oauth'), 'preload must not expose OAuth completion')
  })

  it('AI, Worker, Looplink, and session modules never consume cloud identity', () => {
    const dirs = ['ai', 'worker-tools', 'looplink', 'sessions', 'session-context', 'workspace-files', 'usage', 'heart', 'recovery']
    for (const dir of dirs) {
      const files = listFilesRecursive(join(root(), 'src', 'main', dir), '.ts').filter((file) => !file.endsWith('.test.ts'))
      for (const file of files) {
        const source = readSource(file)
        assert.ok(!source.includes('cloud-account'), `${file} must not import cloud identity`)
        assert.ok(!source.includes('CloudAccount'), `${file} must not reference cloud identity`)
      }
    }
  })

  it('remote profile SQL has own-user RLS and no project tables', () => {
    const sql = readSource(join(root(), 'supabase', 'migrations', '0001_profiles.sql'))
    const lowered = sql.toLowerCase()
    assert.ok(lowered.includes('enable row level security'), 'profiles RLS required')
    assert.ok(sql.includes('auth.uid() = user_id'), 'own-user policy required')
    assert.ok(lowered.includes('for select'), 'select policy required')
    assert.ok(lowered.includes('for insert'), 'insert policy required')
    assert.ok(lowered.includes('for update'), 'update policy required')
    assert.ok(lowered.includes('with check'), 'insert/update check required')
    for (const forbidden of ['workspaces', 'files', 'sessions', 'messages', 'transactions', 'change_sets', 'worker_tool', 'usage_events']) {
      assert.ok(!lowered.includes(`create table ${forbidden}`), `remote SQL must not create ${forbidden}`)
    }
    // Comment lines may document the service-role prohibition; only
    // executable SQL counts as a service-role dependency.
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .toLowerCase()
    assert.ok(!executableSql.includes('service_role'), 'remote SQL must not depend on service_role')
  })

  it('local database has no sync queues, billing, or collaboration tables', () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Record<string, unknown>[]
      const names = rows.map((row) => String(row['name']))
      assert.ok(names.includes('cloud_account'))
      assert.ok(names.includes('cloud_auth_session'))
      for (const forbidden of ['sync', 'upload', 'billing', 'subscription', 'collabor', 'workspace_cache']) {
        assert.ok(!names.some((name) => name.includes(forbidden)), `no ${forbidden} table allowed`)
      }
    } finally {
      db.close()
    }
  })

  it('account UI never displays tokens, codes, or UUID internals', () => {
    const section = readSource(join(root(), 'src', 'renderer', 'src', 'features', 'account', 'AccountSection.tsx'))
    for (const forbidden of ['accessToken', 'refreshToken', 'access_token', 'refresh_token', 'oauthUrl', 'verifier', '<img']) {
      assert.ok(!section.includes(forbidden), `AccountSection must not contain ${forbidden}`)
    }
  })

  it('cloud service debug output never stringifies session envelopes', () => {
    const dir = join(root(), 'src', 'main', 'cloud-account')
    const files = listFilesRecursive(dir, '.ts').filter((file) => !file.endsWith('.test.ts'))
    for (const file of files) {
      const source = readSource(file)
      assert.ok(!source.includes('JSON.stringify(session'), `${file} must not log sessions`)
      assert.ok(!source.includes('console.log'), `${file} must not log auth material`)
      assert.ok(!source.includes('console.dir'), `${file} must not log auth material`)
    }
  })
})
