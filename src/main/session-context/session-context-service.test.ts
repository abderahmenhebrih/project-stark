import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import {
  ContextFileUnavailableError,
  ContextItemTooLargeError,
  InvalidContextRangeError,
  InvalidContextRequestError,
  TooManyContextItemsError,
  TotalContextTooLargeError,
  UnsupportedContextFileError
} from './errors'
import { MAX_CONTEXT_ITEM_BYTES } from './limits'
import { SessionContextService, formatProviderContext } from './session-context-service'

function openHarness(): {
  db: DatabaseSync
  service: SessionContextService
  root: string
  dir: string
  workspaceId: number
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-ctx-'))
  const root = join(dir, 'project')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'line one\nline two\nline three\nline four\nline five\n')
  writeFileSync(join(root, 'notes.md'), '# Notes\n\nSome text here.\n')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0x48, 0x00, 0x49]))
  const created = workspaces.create({ rootPath: root, displayName: 'project', now: 1000 })
  const service = new SessionContextService(workspaces, new WorkspaceFilesService(workspaces))
  return { db, service, root, dir, workspaceId: created.id }
}

describe('session context service', () => {
  it('prepares a file excerpt with path and range', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const draft = await service.prepareExcerpt({ workspaceId, relativePath: 'a.ts', lineStart: 2, lineEnd: 3 })
      assert.equal(draft.kind, 'file-excerpt')
      assert.equal(draft.relativePath, 'a.ts')
      assert.equal(draft.lineStart, 2)
      assert.equal(draft.lineEnd, 3)
      assert.equal(draft.content, 'line two\nline three')
      assert.ok(draft.draftId.startsWith('ctx-'))
      assert.ok(draft.label.includes('a.ts'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepares a whole file', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const draft = await service.prepareWholeFile({ workspaceId, relativePath: 'notes.md' })
      assert.equal(draft.kind, 'whole-file')
      assert.equal(draft.lineStart, 1)
      assert.ok(draft.content.includes('# Notes'))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepares a search-match window around the hit line', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const draft = await service.prepareSearchMatch({ workspaceId, relativePath: 'a.ts', line: 3 })
      assert.equal(draft.kind, 'search-match')
      assert.equal(draft.lineStart, 1)
      // The file ends with a newline, so the split holds a trailing
      // empty sixth line inside the clamped window.
      assert.equal(draft.lineEnd, 6)
      assert.ok(draft.content.includes('line three'))
      const edge = await service.prepareSearchMatch({ workspaceId, relativePath: 'a.ts', line: 1 })
      assert.equal(edge.lineStart, 1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepares a manual note with a defaulted label', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const draft = await service.prepareNote({ workspaceId, content: 'Remember the retry budget.' })
      assert.equal(draft.kind, 'manual-note')
      assert.equal(draft.label, 'Manual note')
      assert.equal(draft.relativePath, null)
      assert.equal(draft.content, 'Remember the retry budget.')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid paths', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: '../evil.ts', lineStart: 1, lineEnd: 2 }),
        InvalidContextRequestError
      )
      await assert.rejects(
        service.prepareWholeFile({ workspaceId, relativePath: '/abs/path.ts' }),
        InvalidContextRequestError
      )
      await assert.rejects(service.prepareWholeFile({ workspaceId: 9999, relativePath: 'a.ts' }), InvalidContextRequestError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid ranges', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: 'a.ts', lineStart: 3, lineEnd: 2 }),
        InvalidContextRangeError
      )
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: 'a.ts', lineStart: 0, lineEnd: 2 }),
        InvalidContextRangeError
      )
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: 'a.ts', lineStart: 99, lineEnd: 100 }),
        InvalidContextRangeError
      )
      await assert.rejects(service.prepareSearchMatch({ workspaceId, relativePath: 'a.ts', line: 0 }), InvalidContextRangeError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects binary and missing files distinctly', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      await assert.rejects(service.prepareWholeFile({ workspaceId, relativePath: 'binary.bin' }), UnsupportedContextFileError)
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: 'gone.ts', lineStart: 1, lineEnd: 2 }),
        ContextFileUnavailableError
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces the per-item byte limit without truncating', async () => {
    const { db, dir, service, workspaceId, root } = openHarness()
    try {
      writeFileSync(join(root, 'big.txt'), `${'x'.repeat(MAX_CONTEXT_ITEM_BYTES + 1)}\n`)
      await assert.rejects(service.prepareWholeFile({ workspaceId, relativePath: 'big.txt' }), ContextItemTooLargeError)
      await assert.rejects(
        service.prepareExcerpt({ workspaceId, relativePath: 'big.txt', lineStart: 1, lineEnd: 1 }),
        ContextItemTooLargeError
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces item-count and total budgets at send resolution', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const drafts = Array.from({ length: 21 }, (_, index) => ({
        draftId: `ctx-${String(index)}`,
        kind: 'manual-note',
        label: 'Manual note',
        relativePath: null,
        lineStart: null,
        lineEnd: null,
        content: 'ok',
        contentBytes: 2
      }))
      await assert.rejects(service.resolveAttachmentsForSend(workspaceId, drafts, 2000), TooManyContextItemsError)
      const heavy = [
        {
          draftId: 'ctx-1',
          kind: 'manual-note',
          label: 'Manual note',
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          content: 'x'.repeat(16 * 1024),
          contentBytes: 16 * 1024
        }
      ]
      const many = Array.from({ length: 13 }, (_, index) => ({ ...heavy[0], draftId: `ctx-h${String(index)}` }))
      await assert.rejects(service.resolveAttachmentsForSend(workspaceId, many, 2000), TotalContextTooLargeError)
      assert.deepEqual(await service.resolveAttachmentsForSend(workspaceId, undefined, 2000), [])
      await assert.rejects(service.resolveAttachmentsForSend(workspaceId, 'nope', 2000), InvalidContextRequestError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-resolves file items from disk instead of trusting drafts', async () => {
    const { db, dir, service, workspaceId, root } = openHarness()
    try {
      const prepared = await service.prepareExcerpt({ workspaceId, relativePath: 'a.ts', lineStart: 1, lineEnd: 1 })
      const revision = (prepared as unknown as Record<string, unknown>)['sourceRevision']
      assert.equal(typeof revision, 'string')
      const forged = {
        draftId: 'ctx-1',
        kind: 'file-excerpt',
        label: 'forged',
        relativePath: 'a.ts',
        lineStart: 1,
        lineEnd: 1,
        content: 'INVENTED BY RENDERER',
        contentBytes: 20,
        sourceRevision: revision
      }
      const [resolved] = await service.resolveAttachmentsForSend(workspaceId, [forged], 2000)
      assert.equal(resolved?.content, 'line one')
      writeFileSync(join(root, 'vanishing.ts'), 'here\n')
      const vanishing = await service.prepareExcerpt({
        workspaceId,
        relativePath: 'vanishing.ts',
        lineStart: 1,
        lineEnd: 1
      })
      const vanishingRevision = (vanishing as unknown as Record<string, unknown>)['sourceRevision']
      const doomed = { ...forged, draftId: 'ctx-2', relativePath: 'vanishing.ts', sourceRevision: vanishingRevision }
      const { rmSync } = await import('node:fs')
      rmSync(join(root, 'vanishing.ts'))
      await assert.rejects(service.resolveAttachmentsForSend(workspaceId, [doomed], 2000), ContextFileUnavailableError)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown draft shapes and kinds at send time', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      await assert.rejects(
        service.resolveAttachmentsForSend(workspaceId, [{ kind: 'tool-call' }], 2000),
        InvalidContextRequestError
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates manual-note labels and size', async () => {
    const { db, dir, service, workspaceId } = openHarness()
    try {
      const named = await service.prepareNote({ workspaceId, label: '  My hypothesis  ', content: 'body text' })
      assert.equal(named.label, 'My hypothesis')
      await assert.rejects(
        service.prepareNote({ workspaceId, label: 'x'.repeat(121), content: 'body' }),
        InvalidContextRequestError
      )
      await assert.rejects(
        service.prepareNote({ workspaceId, label: 'has\nnewline', content: 'body' }),
        InvalidContextRequestError
      )
      await assert.rejects(service.prepareNote({ workspaceId, content: '   ' }), InvalidContextRequestError)
      await assert.rejects(
        service.prepareNote({ workspaceId, content: 'x'.repeat(16 * 1024 + 1) }),
        ContextItemTooLargeError
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('formats the deterministic provider context block', () => {
    const block = formatProviderContext([
      {
        kind: 'file-excerpt',
        label: 'src/a.ts · lines 10–12',
        relativePath: 'src/a.ts',
        lineStart: 10,
        lineEnd: 12,
        content: 'const a = 1\nconst b = 2'
      },
      {
        kind: 'manual-note',
        label: 'user note',
        relativePath: null,
        lineStart: null,
        lineEnd: null,
        content: 'watch the budget'
      }
    ])
    assert.equal(
      block,
      '[CONTEXT 1]\n' +
        'Type: file-excerpt\n' +
        'Path: src/a.ts\n' +
        'Lines: 10-12\n' +
        'Content:\n' +
        'const a = 1\nconst b = 2\n' +
        '\n' +
        '[CONTEXT 2]\n' +
        'Type: manual-note\n' +
        'Label: user note\n' +
        'Content:\n' +
        'watch the budget'
    )
    assert.equal(formatProviderContext([]), '')
  })
})
