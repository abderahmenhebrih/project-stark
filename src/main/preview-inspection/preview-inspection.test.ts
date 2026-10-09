import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations, migrations } from '../database/migrations/index'
import { ProjectRuntimeRepository } from '../project-runtime/project-runtime-repository'
import {
  PreviewInspectionService,
  sanitizeHref,
  sanitizePreviewElement,
  type RawPreviewSnapshot
} from './preview-inspection-service'
import { MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT } from './preview-inspection-script'
import {
  extractTargetPath,
  parsePreviewInspectApprovalArgs,
  parsePreviewInspectArgs,
  previewTargetUrlFor
} from './preview-inspection-validation'
import {
  MAX_PREVIEW_ELEMENT_TEXT_CODEPOINTS,
  MAX_PREVIEW_INSPECTION_ELEMENTS,
  MAX_PREVIEW_INSPECTION_RESULT_BYTES,
  MAX_PREVIEW_VISIBLE_TEXT_BYTES
} from '../worker-tools/worker-tool-limits'

function seedRuntime(db: DatabaseSync, status = 'running', port = 5173): number {
  db.exec("INSERT INTO workspaces (root_path, display_name, created_at, last_opened_at) VALUES ('w', 'w', 1, 1)")
  db.exec("INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (1, 's', 1, 1)")
  db.exec("INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (1, 'user', 'hi', 1)")
  db.exec("INSERT INTO orchestration_runs (workspace_id, session_id, user_message_id, status, created_at, updated_at) VALUES (1, 1, 1, 'running', 1, 1)")
  db.exec(
    "INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, arguments_hash, summary, status, created_at) VALUES (1, 1, 1, 'runtime_start', 'terminal.execute', '{}', 'h', 's', 'consumed', 1)"
  )
  const row = db
    .prepare(
      'INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, program, arguments_json, arguments_hash, preview_port, status, exit_code, signal, stdout_tail, stderr_tail, logs_truncated, total_output_bytes, stop_reason, created_at, started_at, ended_at, updated_at) VALUES (1, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run('npm', '{}', 'h', port, status, null, null, '', '', 0, 0, null, 1, 2, null, 2)
  return Number(row.lastInsertRowid)
}

function rawSnapshot(overrides?: Partial<RawPreviewSnapshot>): RawPreviewSnapshot {
  return {
    title: 'Demo',
    readyState: 'complete',
    url: 'http://127.0.0.1:5173/',
    visibleText: 'Hello world',
    elements: [
      { tag: 'h1', role: null, type: null, name: null, ariaLabel: null, placeholder: null, text: 'Hello', href: null },
      { tag: 'a', role: null, type: null, name: null, ariaLabel: null, placeholder: null, text: 'Dashboard', href: '/dashboard' }
    ],
    ...overrides
  }
}

describe('preview_inspect request validation', () => {
  it('accepts exactly the empty object', () => {
    assert.deepEqual(parsePreviewInspectArgs({}), {})
  })

  it('rejects URL/path/selector/JavaScript authority', () => {
    for (const args of [
      { url: 'http://127.0.0.1:5173/' },
      { path: '/admin' },
      { selector: 'button' },
      { script: 'alert(1)' },
      { javascript: 'x' },
      { runtimeId: 1 },
      { port: 5173 }
    ]) {
      assert.throws(() => parsePreviewInspectArgs(args))
    }
  })

  it('binds exact frozen approval args', () => {
    assert.deepEqual(parsePreviewInspectApprovalArgs({ runtimeId: 3, targetPathAndQueryAndHash: '/a?b=c#d' }), {
      runtimeId: 3,
      targetPathAndQueryAndHash: '/a?b=c#d'
    })
    assert.throws(() => parsePreviewInspectApprovalArgs({ runtimeId: 3 }))
    assert.throws(() => parsePreviewInspectApprovalArgs({ runtimeId: 3, targetPathAndQueryAndHash: 'http://evil/' }))
  })

  it('extracts frozen paths and builds loopback targets main-side', () => {
    assert.equal(extractTargetPath('http://127.0.0.1:5173/dashboard?tab=users#top'), '/dashboard?tab=users#top')
    assert.equal(extractTargetPath('not a url'), '/')
    assert.equal(previewTargetUrlFor(5173, '/dashboard?tab=users'), 'http://127.0.0.1:5173/dashboard?tab=users')
  })
})

describe('preview inspection service', () => {
  it('inspects the visible current path when open', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const id = seedRuntime(db, 'running', 5173)
      const runtimes = new ProjectRuntimeRepository(db)
      let visibleCalls = 0
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => 'http://127.0.0.1:5173/dashboard?tab=users',
        inspectVisible: async (runtimeId) => {
          visibleCalls += 1
          assert.equal(runtimeId, id)
          return rawSnapshot({ url: 'http://127.0.0.1:5173/dashboard?tab=users' })
        },
        createHiddenInspector: () => {
          throw new Error('hidden must not be used when visible matches')
        }
      })
      const outcome = await service.inspect(1)
      assert.equal(outcome.status, 'inspected')
      assert.equal(visibleCalls, 1)
      const payload = JSON.parse(outcome.payloadJson) as { page: { url: string; title: string; readyState: string } }
      assert.equal(payload.page.url, 'http://127.0.0.1:5173/dashboard?tab=users')
      assert.equal(payload.page.title, 'Demo')
      assert.equal(payload.page.readyState, 'complete')
    } finally {
      db.close()
    }
  })

  it('falls back to one hidden root load when no Preview is visible', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      seedRuntime(db, 'running', 5199)
      const runtimes = new ProjectRuntimeRepository(db)
      let loads = 0
      let destroyed = 0
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => null,
        createHiddenInspector: ({ url }) => {
          assert.equal(url, 'http://127.0.0.1:5199/')
          return {
            loadURL: async (target: string) => {
              loads += 1
              assert.equal(target, 'http://127.0.0.1:5199/')
            },
            collectSnapshot: async () => rawSnapshot(),
            destroy: () => {
              destroyed += 1
            },
            isDestroyed: () => false
          }
        }
      })
      const outcome = await service.inspect(1)
      assert.equal(outcome.status, 'inspected')
      assert.equal(loads, 1)
      assert.equal(destroyed, 1)
    } finally {
      db.close()
    }
  })

  it('uses one bounded load attempt with no retry (injectable short timeout)', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      seedRuntime(db, 'running', 5201)
      const runtimes = new ProjectRuntimeRepository(db)
      let loads = 0
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => null,
        loadTimeoutMs: 20,
        createHiddenInspector: () => ({
          loadURL: async () => {
            loads += 1
            await new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error('hang')), 5000)
            })
          },
          collectSnapshot: async () => rawSnapshot(),
          destroy: () => undefined,
          isDestroyed: () => false
        })
      })
      const outcome = await service.inspect(1)
      assert.equal(outcome.status, 'preview_unavailable')
      assert.equal(loads, 1)
    } finally {
      db.close()
    }
  })

  it('returns preview_unavailable when no runtime is active', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const runtimes = new ProjectRuntimeRepository(db)
      const service = new PreviewInspectionService({ runtimes, getVisiblePreviewUrl: () => null })
      const outcome = await service.inspect(999)
      assert.equal(outcome.status, 'preview_unavailable')
    } finally {
      db.close()
    }
  })

  it('caps visible text at 32 KiB with truncation flags', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      seedRuntime(db, 'running', 5173)
      const runtimes = new ProjectRuntimeRepository(db)
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => null,
        createHiddenInspector: () => ({
          loadURL: async () => undefined,
          collectSnapshot: async () => rawSnapshot({ visibleText: 'x'.repeat(100 * 1024) }),
          destroy: () => undefined,
          isDestroyed: () => false
        })
      })
      const outcome = await service.inspect(1)
      assert.equal(outcome.status, 'inspected')
      const payload = JSON.parse(outcome.payloadJson) as { visibleText: string; textTruncated: boolean }
      assert.equal(payload.textTruncated, true)
      assert.ok(Buffer.byteLength(payload.visibleText, 'utf8') <= MAX_PREVIEW_VISIBLE_TEXT_BYTES)
    } finally {
      db.close()
    }
  })

  it('caps elements at 100 with per-element 300 codepoints and 64 KiB total', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      seedRuntime(db, 'running', 5173)
      const runtimes = new ProjectRuntimeRepository(db)
      const many = Array.from({ length: 250 }, (_, index) => ({
        tag: 'button',
        role: null,
        type: null,
        name: null,
        ariaLabel: null,
        placeholder: null,
        text: `${'y'.repeat(500)}-${index}`,
        href: null
      }))
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => null,
        createHiddenInspector: () => ({
          loadURL: async () => undefined,
          collectSnapshot: async () => rawSnapshot({ elements: many }),
          destroy: () => undefined,
          isDestroyed: () => false
        })
      })
      const outcome = await service.inspect(1)
      assert.equal(outcome.status, 'inspected')
      assert.ok(Buffer.byteLength(outcome.payloadJson, 'utf8') <= MAX_PREVIEW_INSPECTION_RESULT_BYTES)
      const payload = JSON.parse(outcome.payloadJson) as {
        elements: { text: string }[]
        elementsTruncated: boolean
      }
      assert.ok(payload.elements.length <= MAX_PREVIEW_INSPECTION_ELEMENTS)
      assert.equal(payload.elementsTruncated, true)
      for (const element of payload.elements) {
        assert.ok([...element.text].length <= MAX_PREVIEW_ELEMENT_TEXT_CODEPOINTS)
      }
    } finally {
      db.close()
    }
  })

  it('keeps same-origin href paths and nulls external ones', () => {
    assert.equal(sanitizeHref('/dashboard', 5173), '/dashboard')
    assert.equal(sanitizeHref('http://127.0.0.1:5173/a?b=c#d', 5173), '/a?b=c#d')
    assert.equal(sanitizeHref('https://example.com/', 5173), null)
    assert.equal(sanitizeHref('http://127.0.0.1:9999/', 5173), null)
    assert.equal(sanitizeHref('javascript:alert(1)', 5173), null)
  })

  it('never returns input values, cookies, or storage', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      seedRuntime(db, 'running', 5173)
      const runtimes = new ProjectRuntimeRepository(db)
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => null,
        createHiddenInspector: () => ({
          loadURL: async () => undefined,
          collectSnapshot: async () =>
            rawSnapshot({
              elements: [
                { tag: 'input', role: null, type: 'password', name: 'pw', ariaLabel: 'Password', placeholder: 'Secret', text: 'typed-secret', href: null },
                { tag: 'textarea', role: null, type: null, name: 'notes', ariaLabel: null, placeholder: null, text: 'draft', href: null }
              ]
            }),
          destroy: () => undefined,
          isDestroyed: () => false
        })
      })
      const outcome = await service.inspect(1)
      const payload = JSON.parse(outcome.payloadJson) as {
        elements: { tag: string; type: string | null; name: string | null; ariaLabel: string | null; placeholder: string | null; text: string }[]
      }
      assert.equal(payload.elements[0]?.type, 'password')
      assert.equal(payload.elements[0]?.name, 'pw')
      const text = outcome.payloadJson.toLowerCase()
      assert.ok(!text.includes('cookie'))
      assert.ok(!text.includes('localstorage'))
      assert.ok(!text.includes('sessionstorage'))
      assert.ok(!text.includes('outerhtml'))
      // Metadata preserved without a value field.
      assert.ok(!('value' in (payload.elements[0] as Record<string, unknown>)))
    } finally {
      db.close()
    }
  })

  it('contains no scripts/styles source or outerHTML', () => {
    const element = sanitizePreviewElement(
      { tag: 'button', role: null, type: null, name: null, ariaLabel: null, placeholder: null, text: 'ok', href: null },
      5173
    )
    assert.deepEqual(Object.keys(element).sort(), ['ariaLabel', 'href', 'name', 'placeholder', 'role', 'tag', 'text', 'type'].sort())
  })

  it('frozen approval inspects the frozen path in a hidden window without touching the human Preview', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      runMigrations(db, migrations)
      const id = seedRuntime(db, 'running', 5173)
      const runtimes = new ProjectRuntimeRepository(db)
      let hiddenUrl = ''
      let visibleInspections = 0
      const service = new PreviewInspectionService({
        runtimes,
        getVisiblePreviewUrl: () => 'http://127.0.0.1:5173/other',
        inspectVisible: async () => {
          visibleInspections += 1
          return rawSnapshot()
        },
        createHiddenInspector: ({ url }) => {
          hiddenUrl = url
          return {
            loadURL: async () => undefined,
            collectSnapshot: async () => rawSnapshot(),
            destroy: () => undefined,
            isDestroyed: () => false
          }
        }
      })
      const outcome = await service.inspect(1, { runtimeId: id, targetPathAndQueryAndHash: '/dashboard?tab=users' })
      assert.equal(outcome.status, 'inspected')
      assert.equal(hiddenUrl, 'http://127.0.0.1:5173/dashboard?tab=users')
      assert.equal(visibleInspections, 0)
    } finally {
      db.close()
    }
  })

  it('exposes the constant main-owned script', () => {
    assert.ok(MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT.includes('querySelectorAll'))
    assert.ok(MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT.length > 100)
  })
})
