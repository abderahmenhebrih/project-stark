import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { ChatAttachment } from '../../shared/chat-attachments/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type {
  CodingSessionRepository,
  NewMessageAttachment
} from '../database/repositories/coding-session-repository'
import {
  ATTACHMENT_ID_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CODEPOINTS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES
} from './limits'
import {
  AttachmentNotFoundError,
  AttachmentTooLargeError,
  ChatAttachmentError,
  InvalidAttachmentRequestError,
  TooManyAttachmentsError,
  TotalAttachmentsTooLargeError,
  UnsupportedAttachmentError
} from './errors'
import { resolveMimeType, sniffImageMime } from './mime'
import { ATTACHMENT_ID_PATTERN } from './protocol'

function countCodePoints(value: string): number {
  return [...value].length
}

function takeCodePoints(value: string, count: number): string {
  return [...value].slice(0, count).join('')
}

/**
 * Display-only filename normalization: strips directory components
 * and control characters, bounds length, and falls back to a fixed
 * label. The result never touches the filesystem as a path.
 */
export function normalizeAttachmentName(sourcePath: string): string {
  const segments = sourcePath.split(/[/\\]/)
  const base = segments[segments.length - 1] ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (cleaned === '') {
    return 'attachment'
  }
  if (countCodePoints(cleaned) > MAX_ATTACHMENT_NAME_CODEPOINTS) {
    return takeCodePoints(cleaned, MAX_ATTACHMENT_NAME_CODEPOINTS)
  }
  return cleaned
}

/** Main-generated opaque IDs: 16 random bytes as 32 lowercase hex. */
export function generateAttachmentId(): string {
  return randomBytes(ATTACHMENT_ID_BYTES).toString('hex')
}

export function isValidAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_PATTERN.test(value)
}

function isValidIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Main-owned chat-attachment store (local files + images, inert).
 *
 * Picked files are validated (regular file only — never symlinks,
 * directories, or special entries), bounded (25 MiB each, 10 per
 * choose batch), copied into STARK-owned userData storage under
 * opaque IDs, hashed (SHA-256), and recorded. The renderer learns
 * normalized metadata only. Draft rows unreferenced by any message
 * may be removed with their backing file; committed rows survive
 * composer resets. Nothing here executes, parses scripts, or
 * contacts any provider.
 */
export class ChatAttachmentService {
  constructor(
    private readonly storeRoot: string,
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository
  ) {}

  private storePathFor(id: string): string {
    if (!isValidAttachmentId(id)) {
      throw new InvalidAttachmentRequestError()
    }
    return join(this.storeRoot, id.slice(0, 2), `${id}.bin`)
  }

  private toPublicAttachment(input: {
    readonly id: string
    readonly originalName: string
    readonly mimeType: string
    readonly sizeBytes: number
    readonly kind: 'image' | 'file'
  }): ChatAttachment {
    return {
      id: input.id,
      name: input.originalName,
      mimeType: input.mimeType,
      size: input.sizeBytes,
      kind: input.kind
    }
  }

  /**
   * Stores one batch of main-picked absolute paths. Returns normalized
   * metadata in picker order. Cancellation is handled by the caller
   * (undefined picks never reach here).
   */
  async chooseAttachments(workspaceId: unknown, pickedPaths: unknown): Promise<ChatAttachment[]> {
    if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
      throw new InvalidAttachmentRequestError()
    }
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new InvalidAttachmentRequestError()
    }
    if (!Array.isArray(pickedPaths)) {
      throw new InvalidAttachmentRequestError()
    }
    if (pickedPaths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new TooManyAttachmentsError()
    }
    const stored: ChatAttachment[] = []
    for (const picked of pickedPaths) {
      if (typeof picked !== 'string' || picked === '') {
        throw new InvalidAttachmentRequestError()
      }
      stored.push(await this.storePickedFile(picked))
    }
    return stored
  }

  private async storePickedFile(sourcePath: string): Promise<ChatAttachment> {
    let stats
    try {
      stats = lstatSync(sourcePath)
    } catch {
      throw new UnsupportedAttachmentError()
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new UnsupportedAttachmentError()
    }
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError()
    }
    const head = readLeadingBytes(sourcePath, 16)
    const name = normalizeAttachmentName(sourcePath)
    const mimeType = resolveMimeType(head, name)
    const kind = sniffImageMime(head) !== null && stats.size <= MAX_IMAGE_PREVIEW_BYTES ? 'image' : 'file'
    const id = generateAttachmentId()
    const dest = this.storePathFor(id)
    mkdirSync(join(this.storeRoot, id.slice(0, 2)), { recursive: true })
    const sha256 = await copyBounded(sourcePath, dest, MAX_ATTACHMENT_BYTES)
    const now = Date.now()
    try {
      this.sessions.insertChatAttachment({
        id,
        originalName: name,
        mimeType,
        sizeBytes: stats.size,
        kind,
        sha256,
        createdAt: now
      })
    } catch (error) {
      rmSync(dest, { force: true })
      throw error
    }
    return this.toPublicAttachment({ id, originalName: name, mimeType, sizeBytes: stats.size, kind })
  }

  /**
   * Stores trusted provider-generated image bytes as a NORMAL chat
   * attachment (Step 5). No source OS path exists — bytes arrive
   * main-side from the image provider adapter only. The image is
   * bounded, magic-verified (never trusting Content-Type alone),
   * SHA-256 hashed, and recorded exactly like a picked attachment, so
   * mobility, review, vision, and persistence all reuse the existing
   * attachment system. There is no separate image universe.
   */
  async createGeneratedImage(input: {
    readonly bytes: Buffer
    readonly mimeType: string
    readonly displayName?: string
  }): Promise<ChatAttachment> {
    const bytes = input.bytes
    if (!(bytes instanceof Buffer) || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError()
    }
    const sniffed = sniffImageMime(bytes.subarray(0, Math.min(bytes.length, 16)))
    if (sniffed === null || sniffed !== input.mimeType) {
      throw new UnsupportedAttachmentError()
    }
    const name = normalizeGeneratedName(input.displayName)
    const id = generateAttachmentId()
    const dest = this.storePathFor(id)
    mkdirSync(join(this.storeRoot, id.slice(0, 2)), { recursive: true })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    try {
      writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 })
    } catch {
      rmSync(dest, { force: true })
      throw new UnsupportedAttachmentError()
    }
    const now = Date.now()
    try {
      this.sessions.insertChatAttachment({
        id,
        originalName: name,
        mimeType: sniffed,
        sizeBytes: bytes.length,
        kind: 'image',
        sha256,
        createdAt: now
      })
    } catch (error) {
      rmSync(dest, { force: true })
      throw error
    }
    return this.toPublicAttachment({ id, originalName: name, mimeType: sniffed, sizeBytes: bytes.length, kind: 'image' })
  }

  /**
   * Removes one draft attachment. Committed attachments (referenced by
   * any message) are kept — only unreferenced backing assets are
   * deleted. Always returns the normalized metadata.
   */
  async removeDraft(attachmentId: unknown): Promise<ChatAttachment> {
    if (!isValidAttachmentId(attachmentId)) {
      throw new InvalidAttachmentRequestError()
    }
    const row = this.sessions.findChatAttachmentById(attachmentId)
    if (row === undefined) {
      throw new AttachmentNotFoundError()
    }
    if (this.sessions.countAttachmentReferences(attachmentId) === 0) {
      rmSync(this.storePathFor(attachmentId), { force: true })
      this.sessions.deleteChatAttachment(attachmentId)
    }
    return this.toPublicAttachment({
      id: row.id,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind
    })
  }

  /**
   * Resolves send-time attachment IDs into persistable link rows.
   * Every ID must exist in the store; count and aggregate byte
   * budgets are enforced — never truncated silently.
   */
  async resolveAttachmentsForSend(ids: unknown, now: number): Promise<NewMessageAttachment[]> {
    if (ids === undefined) {
      return []
    }
    if (!isValidIdList(ids)) {
      throw new InvalidAttachmentRequestError()
    }
    if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new TooManyAttachmentsError()
    }
    const resolved: NewMessageAttachment[] = []
    let total = 0
    for (const id of ids) {
      if (!isValidAttachmentId(id)) {
        throw new InvalidAttachmentRequestError()
      }
      const row = this.sessions.findChatAttachmentById(id)
      if (row === undefined) {
        throw new AttachmentNotFoundError()
      }
      total += row.sizeBytes
      resolved.push({
        attachmentId: row.id,
        originalName: row.originalName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        sha256: row.sha256,
        createdAt: now
      })
    }
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new TotalAttachmentsTooLargeError()
    }
    return resolved
  }

  /**
   * Reads one stored attachment for the content protocol. Resolves
   * the path main-side from the validated ID and proves containment
   * before reading; the file cannot exceed its stored bound.
   */
  readAttachmentContent(attachmentId: string): { readonly bytes: Buffer; readonly mimeType: string } {
    if (!isValidAttachmentId(attachmentId)) {
      throw new InvalidAttachmentRequestError()
    }
    const row = this.sessions.findChatAttachmentById(attachmentId)
    if (row === undefined) {
      throw new AttachmentNotFoundError()
    }
    const resolved = resolve(this.storePathFor(attachmentId))
    const base = resolve(this.storeRoot)
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new ChatAttachmentError('Attachment path is not safe.')
    }
    let stats
    try {
      stats = statSync(resolved)
    } catch {
      throw new AttachmentNotFoundError()
    }
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentNotFoundError()
    }
    try {
      return { bytes: readFileSync(resolved), mimeType: row.mimeType }
    } catch {
      throw new AttachmentNotFoundError()
    }
  }
}

/**
 * Display-only generated-image filename normalization. The
 * provider/model never controls storage paths — the name is metadata
 * only. Falls back to a fixed label on empty input.
 */
function normalizeGeneratedName(displayName: string | undefined): string {
  if (displayName === undefined) {
    return 'generated-image.png'
  }
  const segments = displayName.split(/[/\\]/)
  const base = segments[segments.length - 1] ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (cleaned === '') {
    return 'generated-image.png'
  }
  if (countCodePoints(cleaned) > MAX_ATTACHMENT_NAME_CODEPOINTS) {
    return takeCodePoints(cleaned, MAX_ATTACHMENT_NAME_CODEPOINTS)
  }
  return cleaned
}

function readLeadingBytes(sourcePath: string, count: number): Buffer {  let fd = -1
  try {
    fd = openSync(sourcePath, 'r')
    const buffer = Buffer.alloc(count)
    const read = readSync(fd, buffer, 0, count, 0)
    return buffer.subarray(0, read)
  } catch {
    throw new UnsupportedAttachmentError()
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd)
      } catch {
        // Best effort.
      }
    }
  }
}

/**
 * Bounded stream copy with SHA-256. Aborts past the byte cap so a
 * file that grows mid-copy cannot overflow the store. Cleans up the
 * partial destination on failure.
 */
async function copyBounded(sourcePath: string, destPath: string, capBytes: number): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      bytes += chunk.length
      if (bytes > capBytes) {
        callback(new AttachmentTooLargeError())
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(createReadStream(sourcePath, { flags: 'r' }), counter, createWriteStream(destPath, { flags: 'wx', mode: 0o600 }))
  } catch (error: unknown) {
    rmSync(destPath, { force: true })
    if (error instanceof AttachmentTooLargeError) {
      throw error
    }
    throw new UnsupportedAttachmentError()
  }
  return hash.digest('hex')
}
