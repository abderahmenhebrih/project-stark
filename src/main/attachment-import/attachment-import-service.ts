import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { ChangeSetRepository } from '../database/repositories/change-set-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { ChatAttachmentService } from '../chat-attachments/service'
import { MAX_ATTACHMENT_BYTES } from '../chat-attachments/limits'
import { hashFileBytes } from '../workspace-files/file-revision'
import { requireLiveWorkspace } from '../workspace-files/workspace-file-write-service'
import { WorkspaceNotFoundError } from '../workspace/errors'
import { MAX_ATTACHMENT_IMPORTS_PER_CALL, EMPTY_SHA256 } from './limits'
import {
  AttachmentDestinationExistsError,
  AttachmentDestinationParentMissingError,
  AttachmentImportError,
  AttachmentImportMissingError,
  AttachmentImportScopeError,
  AttachmentImportStateError,
  AttachmentImportTransactionNotFoundError,
  AttachmentImportUncommittedError,
  StaleAttachmentImportError,
  UnsafeAttachmentDestinationError
} from './errors'
import { decodeAttachmentImportManifest, encodeAttachmentImportManifest, type AttachmentImportManifest } from './manifest'
import { validateProposedDestination } from './validation'

/** Prefix for same-directory temp files. Never renderer or model controlled. */
const TEMP_FILE_PREFIX = '.stark-import-tmp-'

function foldCase(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One validated Worker import request (opaque ID + proposed destination only). */
export interface AttachmentImportRequest {
  readonly attachmentId: string
  readonly proposedRelativePath: string
}

/** Review preview for one resolved import (no paths beyond the proposed destination). */
export interface AttachmentImportPreview {
  readonly attachmentId: string
  readonly fileName: string
  readonly destination: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'file'
}

export type ProposeAttachmentImportOutcome =
  | { readonly kind: 'single'; readonly transactionId: number; readonly files: readonly AttachmentImportPreview[] }
  | { readonly kind: 'change_set'; readonly changeSetId: number; readonly files: readonly AttachmentImportPreview[] }

/**
 * Acceptor consulted by ChangeTransactionService for binary-import
 * transactions (type-only boundary — no runtime import cycle).
 */
export interface BinaryImportAcceptor {
  acceptBinaryImport(transactionId: number): Promise<void>
  rollbackBinaryImport(transactionId: number): Promise<void>
}

interface ResolvedImportTarget {
  /** Canonical absolute target path, safe for fs operations. */
  readonly absolutePath: string
  /** Normalized destination form with `/` separators. */
  readonly relativePath: string
}

/**
 * Narrow Worker capability service (Step 3): proposes copying chat
 * attachments into the project as REVIEWABLE binary ADD transactions.
 * Proposal never touches the workspace; only an explicit Accept (via
 * the existing Changes API, routed here by manifest detection) copies
 * exact bytes. Source is always the STARK attachment store — the
 * user's original OS file is irrelevant and may be long deleted.
 */
export class AttachmentImportService implements BinaryImportAcceptor {
  private readonly now: () => number

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly attachments: ChatAttachmentService,
    private readonly transactions: ChangeTransactionRepository,
    private readonly changeSets: ChangeSetRepository,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /**
   * Resolves import previews WITHOUT persisting (approval-summary
   * path). Same validations as proposal, including destination
   * availability — an already-existing destination fails here so the
   * approval never parks for an impossible import.
   */
  async describeImports(input: {
    workspaceId: number
    sessionId: number
    items: readonly AttachmentImportRequest[]
  }): Promise<readonly AttachmentImportPreview[]> {
    const validated = this.validateCallShape(input.items)
    const workspace = await requireLiveWorkspace(this.workspaces, input.workspaceId)
    this.requireSessionScope(input.workspaceId, input.sessionId)
    const previews: AttachmentImportPreview[] = []
    for (const item of validated) {
      const row = this.requireCommittedInSession(item.attachmentId, input.workspaceId, input.sessionId)
      const destination = validateProposedDestination(item.proposedRelativePath)
      await this.resolveCreateTarget(workspace.rootPath, destination, true)
      previews.push({
        attachmentId: row.id,
        fileName: row.originalName,
        destination,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind
      })
    }
    return previews
  }

  /**
   * Creates reviewable binary ADD transactions WITHOUT touching the
   * workspace. One item yields one transaction; several yield one
   * Change Set (kind `ai_multi_file_proposal`). Either every item
   * validates and persists, or nothing does — no partial proposals.
   */
  async proposeImports(input: {
    workspaceId: number
    sessionId: number
    summary: string
    items: readonly AttachmentImportRequest[]
  }): Promise<ProposeAttachmentImportOutcome> {
    const validated = this.validateCallShape(input.items)
    if (typeof input.summary !== 'string' || input.summary.trim() === '') {
      throw new AttachmentImportError('We couldn’t import that attachment.')
    }
    const workspace = await requireLiveWorkspace(this.workspaces, input.workspaceId)
    this.requireSessionScope(input.workspaceId, input.sessionId)
    const seen = new Set<string>()
    const prepared: { readonly preview: AttachmentImportPreview; readonly manifestBytes: Buffer; readonly proposedRevision: string }[] = []
    for (const item of validated) {
      const row = this.requireCommittedInSession(item.attachmentId, input.workspaceId, input.sessionId)
      const destination = validateProposedDestination(item.proposedRelativePath)
      if (seen.has(destination)) {
        throw new UnsafeAttachmentDestinationError()
      }
      seen.add(destination)
      await this.resolveCreateTarget(workspace.rootPath, destination, true)
      const manifest: AttachmentImportManifest = {
        version: 1,
        attachmentId: row.id,
        fileName: row.originalName,
        destination,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        kind: row.kind
      }
      const manifestBytes = encodeAttachmentImportManifest(manifest)
      prepared.push({
        preview: {
          attachmentId: row.id,
          fileName: row.originalName,
          destination,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          kind: row.kind
        },
        manifestBytes,
        proposedRevision: hashFileBytes(manifestBytes)
      })
    }
    const timestamp = this.now()
    const files = prepared.map((entry) => entry.preview)
    if (prepared.length === 1) {
      const single = prepared[0]
      if (single === undefined) {
        throw new AttachmentImportError('We couldn’t import that attachment.')
      }
      const transactionId = this.transactions.createWithFiles({ workspaceId: workspace.id, now: timestamp }, [
        {
          relativePath: single.preview.destination,
          beforeRevision: EMPTY_SHA256,
          beforeBytes: Buffer.alloc(0),
          proposedRevision: single.proposedRevision,
          proposedBytes: single.manifestBytes
        }
      ])
      return { kind: 'single', transactionId, files }
    }
    const changeSetId = this.changeSets.createChangeSet(
      { workspaceId: workspace.id, kind: 'ai_multi_file_proposal', summary: input.summary.trim(), now: timestamp },
      prepared.map((entry, ordinal) => ({
        relativePath: entry.preview.destination,
        beforeRevision: EMPTY_SHA256,
        beforeBytes: Buffer.alloc(0),
        proposedRevision: entry.proposedRevision,
        proposedBytes: entry.manifestBytes,
        ordinal,
        fileSummary: `Import ${entry.preview.fileName} to ${entry.preview.destination}`
      }))
    )
    return { kind: 'change_set', changeSetId, files }
  }

  /**
   * First and only point at which an import may touch the workspace:
   * re-resolves the attachment ID, re-checks SHA-256 against the
   * reviewed manifest, re-checks destination safety and absence, then
   * copies exact bytes atomically (temp sibling + rename). Marks the
   * pending transaction applied. Stays pending on any mismatch.
   */
  async acceptBinaryImport(transactionId: number): Promise<void> {
    const header = this.transactions.findTransaction(transactionId)
    if (header === undefined) {
      throw new AttachmentImportTransactionNotFoundError()
    }
    if (header.status !== 'pending') {
      throw new AttachmentImportStateError()
    }
    const files = this.transactions.findFiles(transactionId)
    if (files.length !== 1 || files[0] === undefined) {
      throw new AttachmentImportTransactionNotFoundError()
    }
    const file = files[0]
    const manifest = decodeAttachmentImportManifest(file.proposedBytes)
    if (manifest === null || file.relativePath !== manifest.destination) {
      throw new StaleAttachmentImportError()
    }
    if (hashFileBytes(file.proposedBytes) !== file.proposedRevision || hashFileBytes(file.beforeBytes) !== file.beforeRevision) {
      throw new StaleAttachmentImportError()
    }
    const workspace = await requireLiveWorkspace(this.workspaces, header.workspaceId)
    const row = this.sessions.findChatAttachmentById(manifest.attachmentId)
    if (
      row === undefined ||
      row.originalName !== manifest.fileName ||
      row.mimeType !== manifest.mimeType ||
      row.sizeBytes !== manifest.sizeBytes ||
      row.kind !== manifest.kind ||
      row.sha256 !== manifest.sha256
    ) {
      throw new StaleAttachmentImportError()
    }
    if (this.sessions.countAttachmentReferences(manifest.attachmentId) === 0) {
      throw new StaleAttachmentImportError()
    }
    let bytes: Buffer
    try {
      bytes = this.attachments.readAttachmentContent(manifest.attachmentId).bytes
    } catch {
      throw new StaleAttachmentImportError()
    }
    if (bytes.byteLength !== manifest.sizeBytes || hashFileBytes(bytes) !== manifest.sha256) {
      throw new StaleAttachmentImportError()
    }
    const target = await this.resolveCreateTarget(workspace.rootPath, manifest.destination, true)
    await this.copyBytesAtomically(target.absolutePath, bytes)
    if (hashFileBytes(bytes) !== manifest.sha256) {
      throw new StaleAttachmentImportError()
    }
    const marked = this.transactions.markApplied(transactionId, manifest.sha256, this.now())
    if (!marked) {
      throw new AttachmentImportStateError()
    }
  }

  /**
   * Restores the reviewed absent checkpoint: deletes the imported file
   * only when its current bytes still match the applied revision.
   * An already-absent target is already at the checkpoint. An
   * externally changed file turns rollback into a stale conflict —
   * never an overwrite.
   */
  async rollbackBinaryImport(transactionId: number): Promise<void> {
    const header = this.transactions.findTransaction(transactionId)
    if (header === undefined) {
      throw new AttachmentImportTransactionNotFoundError()
    }
    if (header.status !== 'applied') {
      throw new AttachmentImportStateError()
    }
    const files = this.transactions.findFiles(transactionId)
    if (files.length !== 1 || files[0] === undefined) {
      throw new AttachmentImportTransactionNotFoundError()
    }
    const file = files[0]
    const manifest = decodeAttachmentImportManifest(file.proposedBytes)
    if (manifest === null || file.relativePath !== manifest.destination) {
      throw new StaleAttachmentImportError()
    }
    if (file.appliedRevision === null || file.appliedRevision !== manifest.sha256) {
      throw new StaleAttachmentImportError()
    }
    const workspace = await requireLiveWorkspace(this.workspaces, header.workspaceId)
    const target = await this.resolveCreateTarget(workspace.rootPath, manifest.destination, false)
    let stats
    try {
      stats = await lstat(target.absolutePath)
    } catch (error) {
      if (isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR')) {
        stats = null
      } else {
        throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
      }
    }
    if (stats !== null) {
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new StaleAttachmentImportError()
      }
      let current: Buffer
      try {
        current = await readFile(target.absolutePath)
      } catch {
        throw new StaleAttachmentImportError()
      }
      if (hashFileBytes(current) !== file.appliedRevision) {
        throw new StaleAttachmentImportError()
      }
      try {
        await unlink(target.absolutePath)
      } catch (error) {
        throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
      }
    }
    const marked = this.transactions.markRolledBack(transactionId, this.now())
    if (!marked) {
      throw new AttachmentImportStateError()
    }
  }

  private validateCallShape(items: unknown): AttachmentImportRequest[] {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ATTACHMENT_IMPORTS_PER_CALL) {
      throw new AttachmentImportError('We couldn’t import that attachment.')
    }
    const validated: AttachmentImportRequest[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new UnsafeAttachmentDestinationError()
      }
      const record = item as Record<string, unknown>
      if (
        Object.keys(record).length !== 2 ||
        typeof record['attachmentId'] !== 'string' ||
        typeof record['proposedRelativePath'] !== 'string'
      ) {
        throw new UnsafeAttachmentDestinationError()
      }
      const attachmentId = record['attachmentId'] as string
      const proposedRelativePath = record['proposedRelativePath'] as string
      if (!/^[0-9a-f]{32}$/.test(attachmentId)) {
        throw new UnsafeAttachmentDestinationError()
      }
      validated.push({ attachmentId, proposedRelativePath })
    }
    return validated
  }

  private requireSessionScope(workspaceId: number, sessionId: number): void {
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined || session.workspaceId !== workspaceId) {
      throw new AttachmentImportScopeError()
    }
  }

  /**
   * Resolves the store row and proves session scope: the attachment
   * must be committed (referenced by a message) AND referenced from
   * THIS session. Drafts and foreign-session attachments fail closed.
   */
  private requireCommittedInSession(attachmentId: string, workspaceId: number, sessionId: number) {
    const row = this.sessions.findChatAttachmentById(attachmentId)
    if (row === undefined) {
      throw new AttachmentImportMissingError()
    }
    if (row.sizeBytes < 0 || row.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new StaleAttachmentImportError()
    }
    const scopes = this.sessions.listAttachmentScopes(attachmentId)
    if (scopes.length === 0) {
      throw new AttachmentImportUncommittedError()
    }
    if (!scopes.some((scope) => scope.sessionId === sessionId && scope.workspaceId === workspaceId)) {
      throw new AttachmentImportScopeError()
    }
    return row
  }

  /**
   * Resolves a NEW-file destination inside a live workspace root.
   * Every existing parent segment must be a non-symlink directory;
   * the final target must be absent when `requireAbsent` (propose and
   * accept) and may be absent-or-present for rollback probing.
   * Symlink escape, sibling-prefix lookalikes, and case tricks are
   * rejected via canonical containment — same guarantees as Stage 6.
   * A residual swap-between-checks race is accepted (documented):
   * accept performs this resolution immediately before the atomic
   * copy, and rollback re-verifies bytes before deleting.
   */
  private async resolveCreateTarget(
    workspaceRoot: string,
    destination: string,
    requireAbsent: boolean
  ): Promise<ResolvedImportTarget> {
    const segments = destination.split('/').filter((segment) => segment !== '' && segment !== '.')
    if (segments.length === 0) {
      throw new UnsafeAttachmentDestinationError()
    }
    for (const segment of segments) {
      if (segment === '..' || segment === '.git') {
        throw new UnsafeAttachmentDestinationError()
      }
    }
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(workspaceRoot)
    } catch (error) {
      throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
    }
    let prefix = canonicalRoot
    for (const segment of segments.slice(0, -1)) {
      prefix = join(prefix, segment)
      let stats
      try {
        stats = await lstat(prefix)
      } catch (error) {
        if (isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR')) {
          throw new AttachmentDestinationParentMissingError()
        }
        throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new UnsafeAttachmentDestinationError()
      }
    }
    const last = segments[segments.length - 1] as string
    const target = join(prefix, last)
    const difference = relative(foldCase(canonicalRoot), foldCase(target))
    if (difference === '' || difference.startsWith('..') || isAbsolute(difference)) {
      throw new UnsafeAttachmentDestinationError()
    }
    let targetStats
    try {
      targetStats = await lstat(target)
    } catch (error) {
      if (isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR')) {
        targetStats = null
      } else {
        throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
      }
    }
    if (targetStats !== null) {
      if (requireAbsent) {
        throw new AttachmentDestinationExistsError()
      }
      if (targetStats.isSymbolicLink()) {
        throw new UnsafeAttachmentDestinationError()
      }
    } else if (!requireAbsent) {
      // Rollback probing resolves the would-be target; absence is
      // reported through the returned path (caller treats absent as
      // already-at-checkpoint). Parent existence was proven above.
    }
    void targetStats
    return { absolutePath: target, relativePath: segments.join('/') }
  }

  /**
   * Copies exact bytes via a same-directory temp file + rename (no
   * partial file on failure). Mirrors the Stage 8 writer pattern:
   * exclusive create, fsync, close, then atomic replacement. The
   * target is proven absent by the caller immediately before.
   */
  private async copyBytesAtomically(targetPath: string, bytes: Buffer): Promise<void> {
    const tempPath = join(dirname(targetPath), `${TEMP_FILE_PREFIX}${String(process.pid)}-${randomBytes(8).toString('hex')}`)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(tempPath, 'wx', 0o666)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = null
      try {
        await rename(tempPath, targetPath)
      } catch (error) {
        try {
          await unlink(tempPath)
        } catch {
          // Best effort — the temp name is unique per operation.
        }
        const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
        if (code === 'EEXIST') {
          throw new AttachmentDestinationExistsError()
        }
        throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
      }
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close()
        } catch {
          // Ignore close failures — removal below is what matters.
        }
      }
      try {
        await unlink(tempPath)
      } catch {
        // Best effort.
      }
      if (
        error instanceof AttachmentDestinationExistsError ||
        error instanceof UnsafeAttachmentDestinationError ||
        error instanceof AttachmentImportError ||
        error instanceof WorkspaceNotFoundError
      ) {
        throw error
      }
      throw new AttachmentImportError('We couldn’t import that attachment.', { cause: error })
    }
  }
}
