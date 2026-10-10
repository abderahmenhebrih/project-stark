import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPC_CHANNELS } from '../../shared/constants'
import { MAX_RECOVERY_HOPS } from '../recovery/recovery-limits'
import { USAGE_THRESHOLD_ROUTE_KEYS } from '../usage/usage-limits'
import {
  MAX_TOOL_WORK_PROVIDER_CALLS,
  MAX_WORKER_TOOL_CALLS,
  MAX_WORKER_TURNS
} from '../worker-tools/worker-tool-limits'
import { isKnownWorkerTool, WORKER_TOOLS } from '../worker-tools/worker-tool-registry'
import { isLegalMode, legalModesFor } from '../capabilities/capability-registry'
import { getUserVersion, migrations, runMigrations } from '../database/migrations/index'
import { buildCspPolicy } from './csp'
import { isAllowedExternalUrl } from './external-url'
import { isTrustedIpcSender } from '../ipc/trust'
import { isTrustedRendererUrl } from '../ipc/sender'
import { buildMainWindowOptions } from '../windows/app-window'
import {
  buildPreviewWindowOptions,
  DENIED_PREVIEW_PERMISSIONS,
  isAllowedPreviewNavigation,
  isDeniedPreviewPermission,
  previewPartitionForRuntime
} from '../project-runtime/runtime-preview'

function root(): string {
  return process.cwd()
}

function executableLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('<!--')
    })
}

function listFilesRecursive(dir: string): string[] {
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
    try {
      if (statSync(full).isDirectory()) {
        out.push(...listFilesRecursive(full))
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        out.push(full)
      }
    } catch {
      continue
    }
  }
  return out
}

describe('release security matrix (Stage 30)', () => {
  it('1. main BrowserWindow stays hardened', () => {
    const options = buildMainWindowOptions()
    const prefs = options.webPreferences ?? {}
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.sandbox, true)
    assert.ok(typeof prefs.preload === 'string' && prefs.preload !== '')
  })

  it('2. Preview window stays isolated and bridgeless', () => {
    const options = buildPreviewWindowOptions(3)
    const prefs = options.webPreferences ?? {}
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.webSecurity, true)
    assert.equal(prefs.preload, undefined)
    assert.equal(prefs.partition, previewPartitionForRuntime(3))
    assert.ok(isAllowedPreviewNavigation('http://127.0.0.1:5173/app', 5173))
    assert.ok(!isAllowedPreviewNavigation('https://example.com/', 5173))
    assert.ok(!isAllowedPreviewNavigation('file:///etc/passwd', 5173))
    for (const permission of ['camera', 'microphone', 'clipboard-read']) {
      assert.ok(DENIED_PREVIEW_PERMISSIONS.includes(permission))
      assert.ok(isDeniedPreviewPermission(permission))
    }
  })

  it('3. hidden inspector and fatal surface create no privileged window', () => {
    // The hidden inspector exists only as an injected seam (no direct
    // BrowserWindow construction); the fatal surface is dialog-based.
    const inspectionFiles = listFilesRecursive(join(root(), 'src', 'main', 'preview-inspection')).filter(
      (file) => !file.endsWith('.test.ts')
    )
    for (const file of inspectionFiles) {
      assert.ok(
        !executableLines(file).join('\n').includes('new BrowserWindow'),
        `${file} must not construct windows directly`
      )
    }
    const fatalSource = executableLines(join(root(), 'src', 'main', 'startup', 'fatal-startup.ts')).join('\n')
    assert.ok(!fatalSource.includes('BrowserWindow'), 'fatal surface must stay dialog-based')
  })

  it('4. trusted IPC sender validation rejects untrusted callers', () => {
    assert.equal(isTrustedIpcSender(true, 'file:///app/index.html', { devServerUrl: undefined, rendererEntryFile: 'x' }), false)
    assert.equal(isTrustedIpcSender(false, 'https://evil.example/', { devServerUrl: undefined, rendererEntryFile: 'x' }), false)
    assert.equal(
      isTrustedRendererUrl('https://evil.example/', { devServerUrl: undefined, rendererEntryFile: undefined }),
      false
    )
  })

  it('5. no generic IPC channel exists', () => {
    for (const channel of Object.values(IPC_CHANNELS) as string[]) {
      assert.ok(channel.startsWith('stark:'), `channel must be stark-scoped: ${channel}`)
      for (const forbidden of ['generic', 'eval', 'exec', 'shell', 'supabase', 'complete-oauth']) {
        assert.ok(!channel.toLowerCase().includes(forbidden), `channel must not contain ${forbidden}`)
      }
    }
    const preload = executableLines(join(root(), 'src', 'preload', 'index.ts')).join('\n')
    assert.ok(!preload.includes("invoke('stark:"), 'preload must not hardcode channel strings')
    assert.ok(!preload.includes('invoke(channel'), 'preload must not invoke variable channels')
    assert.ok(!preload.includes('supabase'), 'preload must not reference Supabase')
  })

  it('6/7. no direct Worker writer and no Worker Accept', () => {
    assert.deepEqual([...WORKER_TOOLS], [
      'workspace_read',
      'workspace_search',
      'git_read',
      'change_propose',
      'attachment_import',
      'image_generate',
      'terminal_execute',
      'runtime_start',
      'runtime_observe',
      'preview_inspect'
    ])
    for (const forbidden of ['file_write', 'accept', 'browser_navigate', 'dom_mutate', 'preview_write']) {
      assert.equal(isKnownWorkerTool(forbidden), false)
    }
    const workerFiles = listFilesRecursive(join(root(), 'src', 'main', 'worker-tools')).filter(
      (file) => !file.endsWith('.test.ts')
    )
    for (const file of workerFiles) {
      assert.ok(!executableLines(file).join('\n').includes('.accept('), `${file} must not accept transactions`)
    }
  })

  it('8. Brain stays tool-free', () => {
    for (const file of ['ai-brain-service.ts', 'ai-completion-service.ts']) {
      const source = executableLines(join(root(), 'src', 'main', 'ai', file)).join('\n')
      assert.ok(!source.includes('tools:'), `${file} must not send provider tools`)
      assert.ok(!source.includes('tool_calls'), `${file} must not handle tool calls`)
    }
  })

  it('9/10. terminal requires exact approval; persistent Allow is impossible', () => {
    assert.deepEqual([...legalModesFor('terminal.execute')], ['deny', 'ask'])
    assert.equal(isLegalMode('terminal.execute', 'allow'), false)
    assert.equal(isLegalMode('terminal.execute', 'ask'), true)
  })

  it('11. runtime requires exact approval (no auto-start surface)', () => {
    const bindings = executableLines(join(root(), 'src', 'main', 'ipc', 'runtimes.ts')).join('\n')
    assert.ok(!bindings.includes('start'), 'no renderer runtime-start channel may exist')
  })

  it('12/13/14. Worker budget=4, turns<=5, Tool Work calls<=7', () => {
    assert.equal(MAX_WORKER_TOOL_CALLS, 4)
    assert.equal(MAX_WORKER_TURNS, 5)
    assert.equal(MAX_TOOL_WORK_PROVIDER_CALLS, 7)
  })

  it('15. Recovery stays single-hop', () => {
    assert.equal(MAX_RECOVERY_HOPS, 1)
  })

  it('16. threshold alternate depth stays one per route', () => {
    assert.ok(USAGE_THRESHOLD_ROUTE_KEYS.length > 0)
    const migration = readFileSync(join(root(), 'src', 'main', 'database', 'migrations', '017-ai-usage-thresholds.ts'), 'utf8')
    assert.ok(migration.includes('route_key TEXT PRIMARY KEY'), 'one alternate per route key by schema')
  })

  it('17/18. no billing/quota polling and no auth polling', () => {
    for (const dir of ['usage', 'cloud-account']) {
      const files = listFilesRecursive(join(root(), 'src', 'main', dir)).filter((file) => !file.endsWith('.test.ts'))
      for (const file of files) {
        const source = executableLines(file).join('\n')
        assert.ok(!source.includes('setInterval'), `${file} must not poll`)
        assert.ok(!source.includes('billing'), `${file} must not touch billing`)
      }
    }
  })

  it('19/20/21. no cloud project sync, no renderer Supabase, no renderer credentials', () => {
    const accountFiles = listFilesRecursive(join(root(), 'src', 'main', 'cloud-account')).filter(
      (file) => !file.endsWith('.test.ts')
    )
    for (const file of accountFiles) {
      const source = executableLines(file).join('\n')
      assert.ok(!source.includes('WorkspaceFilesService'), `${file} must not sync workspaces`)
      assert.ok(!source.includes('CodingSession'), `${file} must not sync sessions`)
    }
    for (const dir of ['renderer', 'preload']) {
      const files = listFilesRecursive(join(root(), 'src', dir))
      for (const file of files) {
        const source = executableLines(file).join('\n')
        assert.ok(!source.includes('@supabase/supabase-js'), `${file} must not import Supabase`)
        // The provider-key settings form legitimately names its input,
        // and redaction tests legitimately name fake secrets while
        // asserting their absence; the invariant is no renderer-side
        // persistence or embedded key material in shipped code.
        assert.ok(!source.includes('localStorage'), `${file} must not persist to web storage`)
        assert.ok(!source.includes('sessionStorage'), `${file} must not persist to web storage`)
        if (!file.endsWith('.test.ts')) {
          assert.ok(!source.includes('sk-'), `${file} must not embed key material`)
        }
      }
    }
  })

  it('22. no service-role config in executable surfaces', () => {
    const surfaceFiles = listFilesRecursive(join(root(), 'src')).filter((file) => !file.endsWith('.test.ts'))
    const allowedGuards = new Set(['supabase-auth-adapter.ts', 'diagnostic-redaction.ts'])
    for (const file of surfaceFiles) {
      if ([...allowedGuards].some((name) => file.endsWith(name))) {
        continue
      }
      assert.ok(
        !executableLines(file).join('\n').includes('SUPABASE_SERVICE_ROLE'),
        `${file} must not reference service-role env`
      )
    }
  })

  it('23/24. no arbitrary browser navigation tool and no DOM mutation tool', () => {
    assert.equal(isKnownWorkerTool('browser_navigate'), false)
    assert.equal(isKnownWorkerTool('browser_open'), false)
    assert.equal(isKnownWorkerTool('dom_mutate'), false)
    assert.equal(isKnownWorkerTool('preview_write'), false)
    const external = executableLines(join(root(), 'src', 'main', 'security', 'external-url.ts')).join('\n')
    assert.ok(external.includes('https'), 'external URLs stay http(s)-scoped')
  })

  it('25/26. no broad process kills and no PID persistence', () => {
    for (const dir of ['startup', 'diagnostics', 'cloud-account']) {
      const files = listFilesRecursive(join(root(), 'src', 'main', dir)).filter((file) => !file.endsWith('.test.ts'))
      for (const file of files) {
        const source = executableLines(file).join('\n')
        assert.ok(!source.includes('taskkill'), `${file} must not kill processes`)
        assert.ok(!source.includes('pkill'), `${file} must not kill processes`)
      }
    }
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      assert.equal(getUserVersion(db), 19)
      for (const table of ['worker_command_executions', 'project_runtime_sessions']) {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as unknown as Record<string, unknown>
        assert.ok(!String(row['sql']).toLowerCase().includes('pid'), `${table} must not persist PIDs`)
      }
    } finally {
      db.close()
    }
  })

  it('27/28. no plaintext auth session and no plaintext provider credential', () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const auth = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cloud_auth_session'")
        .get() as unknown as Record<string, unknown>
      assert.ok(String(auth['sql']).includes('BLOB'), 'auth session must be an opaque BLOB')
      const creds = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_provider_credentials'")
        .get() as unknown as Record<string, unknown>
      assert.ok(String(creds['sql']).includes('BLOB'), 'provider credentials must be opaque BLOBs')
    } finally {
      db.close()
    }
  })

  it('29. no live Workspace file is bundled in release', () => {
    const build = readFileSync(join(root(), 'package.json'), 'utf8')
    const config = JSON.parse(build) as { build?: { files?: unknown } }
    const files = JSON.stringify(config.build?.files ?? [])
    assert.ok(!files.includes('Workspace'), 'release files must not bundle workspaces')
  })

  it('30. CSP and navigation guards stay restrictive', () => {
    const prod = buildCspPolicy(true, undefined)
    assert.ok(!prod.includes('*'), 'production CSP must not wildcard')
    assert.ok(!prod.includes('unsafe-eval'), 'production CSP must not allow eval')
    assert.ok(!isAllowedExternalUrl('javascript:alert(1)'))
    assert.ok(!isAllowedExternalUrl('file:///etc/passwd'))
    assert.ok(isAllowedExternalUrl('https://example.com/'))
  })
})
