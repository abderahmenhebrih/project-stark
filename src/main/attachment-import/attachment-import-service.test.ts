import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { runMigrations, migrations } from '../database/migrations/index'
import { ChangeSetRepository } from '../database/repositories/change-set-repository'
import { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ChatAttachmentService } from '../chat-attachments/service'
import { CodingSessionService } from '../sessions/coding-session-service'
import { ChangeSetService } from '../change-sets/change-set-service'
import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import { CorruptChangeTransactionError } from '../change-transactions/errors'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { AttachmentImportService } from './attachment-import-service'
import {
  AttachmentDestinationExistsError,
  AttachmentImportMissingError,
  AttachmentImportScopeError,
  AttachmentImportUncommittedError,
  StaleAttachmentImportError,
  UnsafeAttachmentDestinationError
} from './errors'

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function pngBytes(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fakepngdatafakepngdata')])
}

function openHarness(): {
  db: DatabaseSync
  dir: string
  projectRoot: string
  storeRoot: string
  workspaceId: number
  attachments: ChatAttachmentService
  sessions: CodingSessionService
  store: CodingSessionRepository
  imports: AttachmentImportService
  transactions: ChangeTransactionService
  changeSets: ChangeSetService
} {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, migrations)
  const workspaces = new WorkspaceRepository(db)
  const store = new CodingSessionRepository(db)
  const dir = mkdtempSync(join(tmpdir(), 'stark-attach-import-'))
  const projectRoot = join(dir, 'project')
  mkdirSync(projectRoot, { recursive: true })
  const storeRoot = join(dir, 'attachments')
  const attachments = new ChatAttachmentService(storeRoot, workspaces, store)
  const workspaceId = workspaces.create({ rootPath: projectRoot, displayName: 'project', now: 1000 }).id
  const sessions = new CodingSessionService(workspaces, store, { attachmentService: attachments })
  const txRows = new ChangeTransactionRepository(db)
  const setRows = new ChangeSetRepository(db)
  const writer = new WorkspaceFileWriteService(workspaces)
  const imports = new AttachmentImportService(workspaces, store, attachments, txRows, setRows, () => 9000)
  const transactions = new ChangeTransactionService(workspaces, txRows, writer, () => 9000, imports)
  const changeSets = new ChangeSetService(workspaces, setRows, txRows, () => 9000)
  return { db, dir, projectRoot, storeRoot, workspaceId, attachments, sessions, store, imports, transactions, changeSets }
}

function closeHarness(h: ReturnType<typeof openHarness>): void {
  h.db.close()
  rmSync(h.dir, { recursive: true, force: true })
}

async function commitAttachment(
  h: ReturnType<typeof openHarness>,
  sessionId: number,
  filename: string,
  bytes: Buffer,
  content = 'Use this'
): Promise<string> {
  const source = join(h.dir, filename)
  writeFileSync(source, bytes)
  const [stored] = await h.attachments.chooseAttachments(h.workspaceId, [source])
  if (stored === undefined) {
    throw new Error('unreachable')
  }
  await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content, attachments: [stored.id] })
  return stored.id
}

async function newSession(h: ReturnType<typeof openHarness>): Promise<number> {
  const session = await h.sessions.createSession({ workspaceId: h.workspaceId })
  return session.id
}

function trySymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'junction')
    return true
  } catch {
    return false
  }
}

describe('attachment import proposals', () => {
  it('fails closed when the destination parent does not exist', async () => {
    const h = openHarness()
    try {
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId,
          summary: 'Import hero',
          items: [{ attachmentId, proposedRelativePath: 'public/images/hero.png' }]
        }),
        /The destination folder does not exist\./
      )
      assert.ok(!existsSync(join(h.projectRoot, 'public')))
    } finally {
      closeHarness(h)
    }
  })

  it('creates a reviewable binary ADD and leaves the workspace unchanged', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public', 'images'), { recursive: true })
      const sessionId = await newSession(h)
      const bytes = pngBytes()
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', bytes)
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import hero',
        items: [{ attachmentId, proposedRelativePath: 'public/images/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'images', 'hero.png')), 'workspace unchanged before Accept')
      const tx = await h.transactions.getTransaction({ transactionId: outcome.transactionId })
      assert.equal(tx.status, 'pending')
      const file = tx.files[0]
      assert.ok(file !== undefined)
      assert.equal(file.relativePath, 'public/images/hero.png')
      assert.ok(file.binaryImport !== undefined, 'review carries structured binary metadata')
      assert.equal(file.binaryImport?.attachmentId, attachmentId)
      assert.equal(file.binaryImport?.destination, 'public/images/hero.png')
      assert.equal(file.binaryImport?.sha256, sha256Hex(bytes))
      assert.equal(file.binaryImport?.sizeBytes, bytes.byteLength)
      assert.equal(file.binaryImport?.kind, 'image')
      // Audit metadata exposes no internal store path.
      const serialized = JSON.stringify(tx)
      assert.ok(!serialized.includes(h.storeRoot), 'no internal store path in audit metadata')
      assert.ok(!serialized.includes(h.dir), 'no absolute temp path in audit metadata')
    } finally {
      closeHarness(h)
    }
  })

  it('rejects uncommitted drafts and unknown attachments', async () => {
    const h = openHarness()
    try {
      const sessionId = await newSession(h)
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const source = join(h.dir, 'draft.png')
      writeFileSync(source, pngBytes())
      const [draft] = await h.attachments.chooseAttachments(h.workspaceId, [source])
      if (draft === undefined) throw new Error('unreachable')
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId,
          summary: 'x',
          items: [{ attachmentId: draft.id, proposedRelativePath: 'public/draft.png' }]
        }),
        AttachmentImportUncommittedError
      )
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId,
          summary: 'x',
          items: [{ attachmentId: '0'.repeat(32), proposedRelativePath: 'public/missing.png' }]
        }),
        AttachmentImportMissingError
      )
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'draft.png')))
    } finally {
      closeHarness(h)
    }
  })

  it('rejects foreign-session attachments and renderer-shaped paths', async () => {
    const h = openHarness()
    try {
      const first = await newSession(h)
      const second = await newSession(h)
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const attachmentId = await commitAttachment(h, first, 'hero.png', pngBytes())
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId: second,
          summary: 'x',
          items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
        }),
        AttachmentImportScopeError
      )
      for (const evil of [
        '../evil.png',
        'a/../../evil.png',
        '/absolute/evil.png',
        'C:\\evil.png',
        '\\\\server\\share\\evil.png',
        'a\0b.png',
        '.git/hooks/evil.png',
        'sub/.git/evil.png'
      ]) {
        await assert.rejects(
          h.imports.proposeImports({
            workspaceId: h.workspaceId,
            sessionId: first,
            summary: 'x',
            items: [{ attachmentId, proposedRelativePath: evil }]
          }),
          UnsafeAttachmentDestinationError,
          evil
        )
      }
      // Model-controlled absolute source paths can never pass shape validation.
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId: first,
          summary: 'x',
          items: [{ attachmentId: join(h.dir, 'hero.png'), proposedRelativePath: 'public/hero.png' } as never]
        }),
        UnsafeAttachmentDestinationError
      )
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId: first,
          summary: 'x',
          items: [{ attachmentId, proposedRelativePath: 'public/hero.png', sourcePath: '/tmp/x' } as never]
        }),
        UnsafeAttachmentDestinationError
      )
    } finally {
      closeHarness(h)
    }
  })

  it('rejects symlink escape and existing destinations', async () => {
    const h = openHarness()
    try {
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      // Existing destination is never overwritten.
      writeFileSync(join(h.projectRoot, 'taken.png'), 'existing')
      await assert.rejects(
        h.imports.proposeImports({
          workspaceId: h.workspaceId,
          sessionId,
          summary: 'x',
          items: [{ attachmentId, proposedRelativePath: 'taken.png' }]
        }),
        AttachmentDestinationExistsError
      )
      assert.equal(readFileSync(join(h.projectRoot, 'taken.png'), 'utf8'), 'existing')
      // Symlinked parent escapes containment.
      const outside = join(h.dir, 'outside')
      mkdirSync(outside, { recursive: true })
      if (trySymlink(outside, join(h.projectRoot, 'linked'))) {
        await assert.rejects(
          h.imports.proposeImports({
            workspaceId: h.workspaceId,
            sessionId,
            summary: 'x',
            items: [{ attachmentId, proposedRelativePath: 'linked/evil.png' }]
          }),
          UnsafeAttachmentDestinationError
        )
        assert.ok(!existsSync(join(outside, 'evil.png')))
      }
    } finally {
      closeHarness(h)
    }
  })

  it('bounds batches to ten and groups multi-asset imports into one set', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'img'), { recursive: true })
      const sessionId = await newSession(h)
      const ids: string[] = []
      for (let index = 0; index < 3; index += 1) {
        ids.push(await commitAttachment(h, sessionId, `f${String(index)}.bin`, Buffer.from([index]), `file ${String(index)}`))
      }
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import three',
        items: ids.map((attachmentId, index) => ({ attachmentId, proposedRelativePath: `img/f${String(index)}.bin` }))
      })
      assert.equal(outcome.kind, 'change_set')
      if (outcome.kind !== 'change_set') throw new Error('unreachable')
      const set = await h.changeSets.getChangeSet({ changeSetId: outcome.changeSetId })
      assert.equal(set.items.length, 3)
      assert.ok(set.items.every((item) => item.transaction.files[0]?.binaryImport !== undefined))
      // Eleven items exceed the batch cap.
      const tooMany = Array.from({ length: 11 }, (_, index) => ({
        attachmentId: ids[0] ?? '0'.repeat(32),
        proposedRelativePath: `img/x${String(index)}.bin`
      }))
      await assert.rejects(
        h.imports.proposeImports({ workspaceId: h.workspaceId, sessionId, summary: 'x', items: tooMany }),
        /We couldn’t import that attachment\./
      )
    } finally {
      closeHarness(h)
    }
  })
})

describe('attachment import accept path', () => {
  it('accept copies exact bytes and rejects with the workspace unchanged', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const sessionId = await newSession(h)
      const bytes = pngBytes()
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', bytes)
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import hero',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      // Reject leaves the workspace unchanged.
      const rejected = await h.transactions.rejectTransaction({ transactionId: outcome.transactionId })
      assert.equal(rejected.status, 'rejected')
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'hero.png')))
      // A fresh proposal accepts exact bytes (reviewed SHA = written bytes).
      const second = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import hero again',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(second.kind, 'single')
      if (second.kind !== 'single') throw new Error('unreachable')
      const applied = await h.transactions.acceptTransaction({ transactionId: second.transactionId })
      assert.equal(applied.status, 'applied')
      const written = readFileSync(join(h.projectRoot, 'public', 'hero.png'))
      assert.ok(written.equals(bytes), 'exact bytes copied')
      assert.equal(sha256Hex(written), applied.files[0]?.binaryImport?.sha256)
      const serialized = JSON.stringify(applied)
      assert.ok(!serialized.includes(h.storeRoot))
    } finally {
      closeHarness(h)
    }
  })

  it('accept works after the original OS file was deleted', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const sessionId = await newSession(h)
      const bytes = pngBytes()
      const source = join(h.dir, 'original.png')
      writeFileSync(source, bytes)
      const [stored] = await h.attachments.chooseAttachments(h.workspaceId, [source])
      if (stored === undefined) throw new Error('unreachable')
      await h.sessions.sendUserMessage({ workspaceId: h.workspaceId, sessionId, content: 'use it', attachments: [stored.id] })
      rmSync(source, { force: true })
      assert.ok(!existsSync(source))
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import',
        items: [{ attachmentId: stored.id, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      await h.transactions.acceptTransaction({ transactionId: outcome.transactionId })
      assert.ok(readFileSync(join(h.projectRoot, 'public', 'hero.png')).equals(bytes))
    } finally {
      closeHarness(h)
    }
  })

  it('stale store bytes and existing destinations fail a pending accept', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      // Tamper with the store bytes main-side: reviewed SHA no longer matches.
      const storeFile = join(h.storeRoot, attachmentId.slice(0, 2), `${attachmentId}.bin`)
      writeFileSync(storeFile, Buffer.from('tampered-bytes'))
      await assert.rejects(h.transactions.acceptTransaction({ transactionId: outcome.transactionId }), StaleAttachmentImportError)
      const still = await h.transactions.getTransaction({ transactionId: outcome.transactionId })
      assert.equal(still.status, 'pending')
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'hero.png')))
    } finally {
      closeHarness(h)
    }
  })

  it('rollback restores the absent checkpoint and refuses changed files', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      await h.transactions.acceptTransaction({ transactionId: outcome.transactionId })
      assert.ok(existsSync(join(h.projectRoot, 'public', 'hero.png')))
      const rolled = await h.transactions.rollbackTransaction({ transactionId: outcome.transactionId })
      assert.equal(rolled.status, 'rolled_back')
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'hero.png')))
      // Second scenario: external change after apply blocks rollback.
      const second = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import again',
        items: [{ attachmentId, proposedRelativePath: 'public/hero2.png' }]
      })
      assert.equal(second.kind, 'single')
      if (second.kind !== 'single') throw new Error('unreachable')
      await h.transactions.acceptTransaction({ transactionId: second.transactionId })
      writeFileSync(join(h.projectRoot, 'public', 'hero2.png'), 'externally changed')
      await assert.rejects(h.transactions.rollbackTransaction({ transactionId: second.transactionId }), StaleAttachmentImportError)
      const applied = await h.transactions.getTransaction({ transactionId: second.transactionId })
      assert.equal(applied.status, 'applied')
    } finally {
      closeHarness(h)
    }
  })

  it('binary transactions never flow through the text writer', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      // A transaction service WITHOUT the import acceptor cannot apply binary rows.
      const writer = new WorkspaceFileWriteService(new WorkspaceRepository(h.db))
      const txRows = new ChangeTransactionRepository(h.db)
      const bare = new ChangeTransactionService(new WorkspaceRepository(h.db), txRows, writer, () => 9000)
      await assert.rejects(bare.acceptTransaction({ transactionId: outcome.transactionId }), CorruptChangeTransactionError)
      assert.ok(!existsSync(join(h.projectRoot, 'public', 'hero.png')))
    } finally {
      closeHarness(h)
    }
  })

  it('binary and text edits coexist in one review set with independent accept', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      writeFileSync(join(h.projectRoot, 'app.ts'), 'export const x = 1\n')
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      const binary = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import hero',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(binary.kind, 'single')
      if (binary.kind !== 'single') throw new Error('unreachable')
      const text = await h.transactions.createFileChange({
        workspaceId: h.workspaceId,
        relativePath: 'app.ts',
        expectedRevision: sha256Hex(Buffer.from('export const x = 1\n')),
        proposedContent: 'export const x = 2\n'
      })
      const grouped = await h.changeSets.groupTransactionsIntoSet({
        workspaceId: h.workspaceId,
        summary: 'Combined attachment and code proposal (2 files)',
        items: [
          { transactionId: binary.transactionId, fileSummary: 'Import hero.png to public/hero.png' },
          { transactionId: text.id, fileSummary: 'Update app.ts' }
        ]
      })
      assert.equal(grouped.items.length, 2)
      assert.ok(grouped.items[0]?.transaction.files[0]?.binaryImport !== undefined)
      assert.ok(grouped.items[1]?.transaction.files[0]?.binaryImport === undefined)
      // Independent review: accept the asset, reject the code edit.
      await h.transactions.acceptTransaction({ transactionId: binary.transactionId })
      await h.transactions.rejectTransaction({ transactionId: text.id })
      assert.ok(existsSync(join(h.projectRoot, 'public', 'hero.png')))
      assert.equal(readFileSync(join(h.projectRoot, 'app.ts'), 'utf8'), 'export const x = 1\n')
    } finally {
      closeHarness(h)
    }
  })

  it('workspace file listing is unchanged apart from the imported file', async () => {
    const h = openHarness()
    try {
      mkdirSync(join(h.projectRoot, 'public'), { recursive: true })
      writeFileSync(join(h.projectRoot, 'keep.ts'), 'keep\n')
      const before = readdirSync(h.projectRoot).sort()
      const sessionId = await newSession(h)
      const attachmentId = await commitAttachment(h, sessionId, 'hero.png', pngBytes())
      const outcome = await h.imports.proposeImports({
        workspaceId: h.workspaceId,
        sessionId,
        summary: 'Import',
        items: [{ attachmentId, proposedRelativePath: 'public/hero.png' }]
      })
      assert.equal(outcome.kind, 'single')
      if (outcome.kind !== 'single') throw new Error('unreachable')
      await h.transactions.acceptTransaction({ transactionId: outcome.transactionId })
      assert.deepEqual(readdirSync(h.projectRoot).sort(), before)
      assert.deepEqual(readdirSync(join(h.projectRoot, 'public')).sort(), ['hero.png'])
    } finally {
      closeHarness(h)
    }
  })
})
