import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceService } from '../workspace/workspace-service'
import { buildTerminalEnv } from './terminal-environment'
import { TerminalService } from './terminal-service'

function openRepositories(): { db: DatabaseSync; workspaces: WorkspaceRepository } {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  return { db, workspaces: new WorkspaceRepository(db) }
}

/**
 * Stage 11 workspace cwd authority + environment: creation resolves
 * the persisted workspace root to a live canonical directory (never
 * HOME, never renderer-chosen), and the PTY environment is built in
 * main without renderer input or secret logging.
 */
describe('terminal service', () => {
  it('validates create requests without accepting cwd, shell, or env', () => {
    const { db, workspaces } = openRepositories()
    try {
      const service = new TerminalService(workspaces)
      assert.deepEqual(service.validateCreateRequest({ workspaceId: 1, cols: 80, rows: 24 }), {
        workspaceId: 1,
        cols: 80,
        rows: 24
      })
      for (const bad of [
        null,
        undefined,
        'x',
        {},
        { workspaceId: 0, cols: 80, rows: 24 },
        { workspaceId: '1', cols: 80, rows: 24 },
        { workspaceId: 1, cols: '80', rows: 24 },
        { workspaceId: 1, cols: 80 },
        { workspaceId: 1, cols: 80, rows: 24, cwd: '/tmp', shell: '/bin/evil', env: {} }
      ]) {
        // Extra fields are ignored structurally, but invalid core
        // fields (or non-objects) must throw controlled errors.
        if (
          typeof bad === 'object' &&
          bad !== null &&
          (bad as Record<string, unknown>)['workspaceId'] === 1 &&
          (bad as Record<string, unknown>)['cols'] === 80 &&
          (bad as Record<string, unknown>)['rows'] === 24
        ) {
          assert.deepEqual(service.validateCreateRequest(bad), { workspaceId: 1, cols: 80, rows: 24 })
        } else {
          assert.throws(() => service.validateCreateRequest(bad), /invalid/)
        }
      }
    } finally {
      db.close()
    }
  })

  it('resolves the persisted workspace root to a live canonical cwd', async () => {
    const { db, workspaces } = openRepositories()
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-cwd-'))
    try {
      const service = new TerminalService(workspaces)
      const workspaceService = new WorkspaceService(workspaces)
      const created = await workspaceService.openDirectory(dir)
      const cwd = await service.resolveWorkspaceCwd(created.id)
      assert.ok(typeof cwd === 'string' && cwd.length > 0)
      assert.ok(!cwd.includes('\0'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails with safe copy when the workspace is gone (never HOME)', async () => {
    const { db, workspaces } = openRepositories()
    const dir = mkdtempSync(join(tmpdir(), 'stark-term-gone-'))
    try {
      const service = new TerminalService(workspaces)
      const workspaceService = new WorkspaceService(workspaces)
      const created = await workspaceService.openDirectory(dir)
      rmSync(dir, { recursive: true, force: true })
      await assert.rejects(
        service.resolveWorkspaceCwd(created.id),
        /That project folder is no longer available\./
      )
      await assert.rejects(service.resolveWorkspaceCwd(created.id + 9999), /That project folder is no longer available\./)
    } finally {
      db.close()
    }
  })

  it('builds PTY env in main with terminal markers and no renderer input', () => {
    const env = buildTerminalEnv({ PATH: '/usr/bin', EMPTY: '', HOME: '/home/u', SECRET: 's3cret' })
    assert.equal(env['TERM'], 'xterm-256color')
    assert.equal(env['COLORTERM'], 'truecolor')
    assert.equal(env['TERM_PROGRAM'], 'STARK')
    assert.equal(env['PATH'], '/usr/bin')
    assert.ok(!('EMPTY' in env))
  })
})
