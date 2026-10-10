import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { CodingMessageRole } from '../../../shared/sessions/types'
import type { SessionContextKind } from '../../../shared/context/types'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored coding session ${what} is invalid`)
  }
  return numeric
}

/** Raw session row as stored (snake_case). */
export interface StoredCodingSession {
  readonly id: number
  readonly workspaceId: number
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw message row as stored (snake_case). */
export interface StoredCodingMessage {
  readonly id: number
  readonly sessionId: number
  readonly role: CodingMessageRole
  readonly content: string
  readonly createdAt: number
}

function mapSession(row: unknown): StoredCodingSession {
  if (!isRecord(row)) {
    throw new DatabaseError('stored coding session row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const title = row['title']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof title !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored coding session row is invalid')
  }
  return { id, workspaceId, title, createdAt, updatedAt }
}

function mapMessage(row: unknown): StoredCodingMessage {
  if (!isRecord(row)) {
    throw new DatabaseError('stored coding message row is invalid')
  }
  const role = row['role']
  if (role !== 'user' && role !== 'assistant') {
    throw new DatabaseError('stored coding message row is invalid')
  }
  const id = row['id']
  const sessionId = row['session_id']
  const content = row['content']
  const createdAt = row['created_at']
  if (
    typeof id !== 'number' ||
    typeof sessionId !== 'number' ||
    typeof content !== 'string' ||
    typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored coding message row is invalid')
  }
  return { id, sessionId, role, content, createdAt }
}

export interface NewCodingSession {
  readonly workspaceId: number
  readonly title: string
  readonly now: number
}

export interface AppendCodingMessage {
  readonly sessionId: number
  readonly role: CodingMessageRole
  readonly content: string
  readonly now: number
  /**
   * First-message retitle, applied only when the session still carries
   * `expectedTitle`. Null disables the title update (timestamp still
   * advances). Evaluated inside the same SQLite transaction.
   */
  readonly retitle: { readonly expectedTitle: string; readonly newTitle: string } | null
}

/** Raw chat-attachment row as stored (snake_case, metadata only). */
export interface StoredChatAttachment {
  readonly id: string
  readonly originalName: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'file'
  readonly sha256: string
  readonly createdAt: number
}

/** One attachment row to persist when main stores a picked file. */
export interface NewChatAttachment {
  readonly id: string
  readonly originalName: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'file'
  readonly sha256: string
  readonly createdAt: number
}

/** Raw message-attachment link row as stored (snake_case). */
export interface StoredMessageAttachment {
  readonly id: number
  readonly messageId: number
  readonly attachmentId: string
  readonly originalName: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'file'
  readonly sha256: string
  readonly createdAt: number
}

/** One message-attachment link to persist alongside a new message. */
export interface NewMessageAttachment {
  readonly attachmentId: string
  readonly originalName: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly kind: 'image' | 'file'
  readonly sha256: string
  readonly createdAt: number
}

const VALID_ATTACHMENT_KINDS: readonly string[] = ['image', 'file']

function mapChatAttachment(row: unknown): StoredChatAttachment {
  if (!isRecord(row)) {
    throw new DatabaseError('stored chat attachment row is invalid')
  }
  const id = row['id']
  const originalName = row['original_name']
  const mimeType = row['mime_type']
  const sizeBytes = row['size_bytes']
  const kind = row['kind']
  const sha256 = row['sha256']
  const createdAt = row['created_at']
  if (
    typeof id !== 'string' ||
    typeof originalName !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof sizeBytes !== 'number' ||
    typeof kind !== 'string' ||
    !VALID_ATTACHMENT_KINDS.includes(kind) ||
    typeof sha256 !== 'string' ||
    typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored chat attachment row is invalid')
  }
  return { id, originalName, mimeType, sizeBytes, kind: kind as 'image' | 'file', sha256, createdAt }
}

function mapMessageAttachment(row: unknown): StoredMessageAttachment {
  if (!isRecord(row)) {
    throw new DatabaseError('stored message attachment row is invalid')
  }
  const id = row['id']
  const messageId = row['message_id']
  const attachmentId = row['attachment_id']
  const originalName = row['original_name']
  const mimeType = row['mime_type']
  const sizeBytes = row['size_bytes']
  const kind = row['kind']
  const sha256 = row['sha256']
  const createdAt = row['created_at']
  if (
    typeof id !== 'number' ||
    typeof messageId !== 'number' ||
    typeof attachmentId !== 'string' ||
    typeof originalName !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof sizeBytes !== 'number' ||
    typeof kind !== 'string' ||
    !VALID_ATTACHMENT_KINDS.includes(kind) ||
    typeof sha256 !== 'string' ||
    typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored message attachment row is invalid')
  }
  return {
    id,
    messageId,
    attachmentId,
    originalName,
    mimeType,
    sizeBytes,
    kind: kind as 'image' | 'file',
    sha256,
    createdAt
  }
}
/** Raw message-context row as stored (snake_case). */
export interface StoredMessageContext {
  readonly id: number
  readonly messageId: number
  readonly kind: SessionContextKind
  readonly label: string
  readonly relativePath: string | null
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly contentBytes: number
  readonly createdAt: number
}

/** One context row to persist alongside a new message. */
export interface NewMessageContext {
  readonly kind: SessionContextKind
  readonly label: string
  readonly relativePath: string | null
  readonly lineStart: number | null
  readonly lineEnd: number | null
  readonly content: string
  readonly contentBytes: number
  readonly createdAt: number
}

const VALID_CONTEXT_KINDS: readonly string[] = ['file-excerpt', 'whole-file', 'search-match', 'manual-note']

function mapMessageContext(row: unknown): StoredMessageContext {
  if (!isRecord(row)) {
    throw new DatabaseError('stored message context row is invalid')
  }
  const kind = row['kind']
  if (typeof kind !== 'string' || !VALID_CONTEXT_KINDS.includes(kind)) {
    throw new DatabaseError('stored message context row is invalid')
  }
  const id = row['id']
  const messageId = row['message_id']
  const label = row['label']
  const relativePath = row['relative_path']
  const lineStart = row['line_start']
  const lineEnd = row['line_end']
  const content = row['content']
  const contentBytes = row['content_bytes']
  const createdAt = row['created_at']
  if (
    typeof id !== 'number' ||
    typeof messageId !== 'number' ||
    typeof label !== 'string' ||
    (relativePath !== null && typeof relativePath !== 'string') ||
    (lineStart !== null && typeof lineStart !== 'number') ||
    (lineEnd !== null && typeof lineEnd !== 'number') ||
    typeof content !== 'string' ||
    typeof contentBytes !== 'number' ||
    typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored message context row is invalid')
  }
  return {
    id,
    messageId,
    kind: kind as SessionContextKind,
    label,
    relativePath,
    lineStart,
    lineEnd,
    content,
    contentBytes,
    createdAt
  }
}

/**
 * Typed main-process repository over coding_sessions and
 * coding_messages. Persistence only: no validation, no title logic,
 * no workspace concerns. Every statement is prepared once with
 * parameter binding. Message appends run inside one SQLite transaction
 * together with the session timestamp/title update, so partial state
 * (message without session touch) is impossible.
 */
export class CodingSessionRepository {
  private readonly db: DatabaseSync
  private readonly insertSessionStmt: StatementSync
  private readonly findSessionStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly insertMessageStmt: StatementSync
  private readonly touchSessionStmt: StatementSync
  private readonly retitleSessionStmt: StatementSync
  private readonly listMessagesDescStmt: StatementSync
  private readonly findMessageStmt: StatementSync
  private readonly insertMessageContextStmt: StatementSync
  private readonly listMessageContextStmt: StatementSync
  private readonly insertChatAttachmentStmt: StatementSync
  private readonly findChatAttachmentStmt: StatementSync
  private readonly countAttachmentReferencesStmt: StatementSync
  private readonly insertMessageAttachmentStmt: StatementSync
  private readonly listMessageAttachmentsStmt: StatementSync
  private readonly deleteChatAttachmentStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertSessionStmt = db.prepare(
      'INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    this.findSessionStmt = db.prepare(
      'SELECT id, workspace_id, title, created_at, updated_at FROM coding_sessions WHERE id = ?'
    )
    this.listRecentStmt = db.prepare(
      'SELECT id, workspace_id, title, created_at, updated_at FROM coding_sessions ' +
        'WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?'
    )
    this.insertMessageStmt = db.prepare(
      'INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    this.touchSessionStmt = db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?')
    this.retitleSessionStmt = db.prepare(
      'UPDATE coding_sessions SET updated_at = ?, title = ? WHERE id = ? AND title = ?'
    )
    // Newest-first probe (LIMIT page+1); callers reverse for display.
    this.listMessagesDescStmt = db.prepare(
      'SELECT id, session_id, role, content, created_at FROM coding_messages ' +
        'WHERE session_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?'
    )
    this.findMessageStmt = db.prepare(
      'SELECT id, session_id, role, content, created_at FROM coding_messages WHERE id = ?'
    )
    this.insertMessageContextStmt = db.prepare(
      'INSERT INTO message_context_items ' +
        '(message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.listMessageContextStmt = db.prepare(
      'SELECT id, message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at ' +
        'FROM message_context_items WHERE message_id = ? ORDER BY id ASC'
    )
    this.insertChatAttachmentStmt = db.prepare(
      'INSERT INTO chat_attachments (id, original_name, mime_type, size_bytes, kind, sha256, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    this.findChatAttachmentStmt = db.prepare(
      'SELECT id, original_name, mime_type, size_bytes, kind, sha256, created_at FROM chat_attachments WHERE id = ?'
    )
    this.countAttachmentReferencesStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM message_attachments WHERE attachment_id = ?'
    )
    this.insertMessageAttachmentStmt = db.prepare(
      'INSERT INTO message_attachments ' +
        '(message_id, attachment_id, original_name, mime_type, size_bytes, kind, sha256, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.listMessageAttachmentsStmt = db.prepare(
      'SELECT id, message_id, attachment_id, original_name, mime_type, size_bytes, kind, sha256, created_at ' +
        'FROM message_attachments WHERE message_id = ? ORDER BY id ASC'
    )
    this.deleteChatAttachmentStmt = db.prepare('DELETE FROM chat_attachments WHERE id = ?')
  }

  /** Inserts a session row and returns its id. */
  createSession(input: NewCodingSession): number {
    const result = this.insertSessionStmt.run(input.workspaceId, input.title, input.now, input.now)
    return toRowId(result.lastInsertRowid, 'session')
  }

  /** Finds one session by id, or undefined. */
  findSessionById(id: number): StoredCodingSession | undefined {
    const row: unknown = this.findSessionStmt.get(id)
    return row === undefined ? undefined : mapSession(row)
  }

  /** Newest-first sessions for one workspace, capped by limit. */
  listRecentSessions(workspaceId: number, limit: number): StoredCodingSession[] {
    const rows: unknown = this.listRecentStmt.all(workspaceId, limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored coding session rows are invalid')
    }
    return rows.map(mapSession)
  }

  /**
   * Atomically inserts one message and advances the session timestamp
   * (plus the conditional first-message retitle). Returns the new
   * message id and whether the title changed.
   */
  appendMessage(input: AppendCodingMessage): { messageId: number; titleChanged: boolean } {
    let messageId: number
    let titleChanged = false
    this.db.exec('BEGIN')
    try {
      const result = this.insertMessageStmt.run(input.sessionId, input.role, input.content, input.now)
      messageId = toRowId(result.lastInsertRowid, 'message')
      if (input.retitle !== null) {
        const updated = this.retitleSessionStmt.run(
          input.now,
          input.retitle.newTitle,
          input.sessionId,
          input.retitle.expectedTitle
        )
        const changed = typeof updated.changes === 'bigint' ? Number(updated.changes) : updated.changes
        titleChanged = changed !== 0
        if (!titleChanged) {
          this.touchSessionStmt.run(input.now, input.sessionId)
        }
      } else {
        this.touchSessionStmt.run(input.now, input.sessionId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return { messageId, titleChanged }
  }

  /** Finds one message by id, or undefined. */
  findMessageById(id: number): StoredCodingMessage | undefined {
    const row: unknown = this.findMessageStmt.get(id)
    return row === undefined ? undefined : mapMessage(row)
  }

  /**
   * Atomically inserts one message, its context rows, its attachment
   * links, and advances the session timestamp (plus the conditional
   * first-message retitle). Either everything lands or nothing does —
   * a message without its rows (or vice versa) is impossible.
   */
  appendMessageWithContext(
    input: AppendCodingMessage,
    contextItems: readonly NewMessageContext[]
  ): { messageId: number; titleChanged: boolean } {
    return this.appendMessageWithAttachments(input, contextItems, [])
  }

  /**
   * Atomically inserts one message, its context rows, its attachment
   * links, and advances the session timestamp (plus the conditional
   * first-message retitle). Either everything lands or nothing does —
   * a message without its rows (or vice versa) is impossible.
   */
  appendMessageWithAttachments(
    input: AppendCodingMessage,
    contextItems: readonly NewMessageContext[],
    attachments: readonly NewMessageAttachment[]
  ): { messageId: number; titleChanged: boolean } {
    let messageId: number
    let titleChanged = false
    this.db.exec('BEGIN')
    try {
      const result = this.insertMessageStmt.run(input.sessionId, input.role, input.content, input.now)
      messageId = toRowId(result.lastInsertRowid, 'message')
      for (const item of contextItems) {
        this.insertMessageContextStmt.run(
          messageId,
          item.kind,
          item.label,
          item.relativePath,
          item.lineStart,
          item.lineEnd,
          item.content,
          item.contentBytes,
          item.createdAt
        )
      }
      for (const attachment of attachments) {
        this.insertMessageAttachmentStmt.run(
          messageId,
          attachment.attachmentId,
          attachment.originalName,
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.kind,
          attachment.sha256,
          attachment.createdAt
        )
      }
      if (input.retitle !== null) {
        const updated = this.retitleSessionStmt.run(
          input.now,
          input.retitle.newTitle,
          input.sessionId,
          input.retitle.expectedTitle
        )
        const changed = typeof updated.changes === 'bigint' ? Number(updated.changes) : updated.changes
        titleChanged = changed !== 0
        if (!titleChanged) {
          this.touchSessionStmt.run(input.now, input.sessionId)
        }
      } else {
        this.touchSessionStmt.run(input.now, input.sessionId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return { messageId, titleChanged }
  }

  /** All context rows for one message, insertion order. */
  listContextForMessage(messageId: number): StoredMessageContext[] {
    const rows: unknown = this.listMessageContextStmt.all(messageId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored message context rows are invalid')
    }
    return rows.map(mapMessageContext)
  }

  /** Persists one attachment metadata row (backing file stored main-side). */
  insertChatAttachment(input: NewChatAttachment): void {
    this.insertChatAttachmentStmt.run(
      input.id,
      input.originalName,
      input.mimeType,
      input.sizeBytes,
      input.kind,
      input.sha256,
      input.createdAt
    )
  }

  /** Finds one attachment metadata row by opaque id, or undefined. */
  findChatAttachmentById(id: string): StoredChatAttachment | undefined {
    const row: unknown = this.findChatAttachmentStmt.get(id)
    return row === undefined ? undefined : mapChatAttachment(row)
  }

  /** Counts message links referencing one attachment (commit detection). */
  countAttachmentReferences(attachmentId: string): number {
    const row: unknown = this.countAttachmentReferencesStmt.get(attachmentId)
    if (!isRecord(row) || typeof row['n'] !== 'number') {
      throw new DatabaseError('stored message attachment rows are invalid')
    }
    return row['n']
  }

  /** Deletes one attachment metadata row (backing file removed main-side). */
  deleteChatAttachment(id: string): void {
    this.deleteChatAttachmentStmt.run(id)
  }

  /** All attachment links for one message, insertion order. */
  listAttachmentsForMessage(messageId: number): StoredMessageAttachment[] {
    const rows: unknown = this.listMessageAttachmentsStmt.all(messageId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored message attachment rows are invalid')
    }
    return rows.map(mapMessageAttachment)
  }

  /**
   * Attachment links for many messages in one query. Returns a map
   * from message id to its links (insertion order); messages without
   * links are absent from the map.
   */
  listAttachmentsForMessages(messageIds: readonly number[]): Map<number, StoredMessageAttachment[]> {
    const grouped = new Map<number, StoredMessageAttachment[]>()
    if (messageIds.length === 0) {
      return grouped
    }
    const placeholders = messageIds.map(() => '?').join(',')
    const rows: unknown = this.db
      .prepare(
        'SELECT id, message_id, attachment_id, original_name, mime_type, size_bytes, kind, sha256, created_at ' +
          `FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`
      )
      .all(...messageIds)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored message attachment rows are invalid')
    }
    for (const row of rows.map(mapMessageAttachment)) {
      const existing = grouped.get(row.messageId)
      if (existing === undefined) {
        grouped.set(row.messageId, [row])
      } else {
        existing.push(row)
      }
    }
    return grouped
  }

  /**
   * Context rows for many messages in one query. Returns a map from
   * message id to its rows (insertion order); messages without rows
   * are absent from the map.
   */
  listContextForMessages(messageIds: readonly number[]): Map<number, StoredMessageContext[]> {
    const grouped = new Map<number, StoredMessageContext[]>()
    if (messageIds.length === 0) {
      return grouped
    }
    const placeholders = messageIds.map(() => '?').join(',')
    const rows: unknown = this.db
      .prepare(
        'SELECT id, message_id, kind, label, relative_path, line_start, line_end, content, content_bytes, created_at ' +
          `FROM message_context_items WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`
      )
      .all(...messageIds)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored message context rows are invalid')
    }
    for (const row of rows.map(mapMessageContext)) {
      const existing = grouped.get(row.messageId)
      if (existing === undefined) {
        grouped.set(row.messageId, [row])
      } else {
        existing.push(row)
      }
    }
    return grouped
  }

  /**
   * Newest-first message probe for one session: up to `limit + 1` rows
   * older than `beforeMessageId` (or the newest rows when null).
   * The extra row is the `hasMore` probe — callers slice it off.
   */
  listMessagesNewestFirst(
    sessionId: number,
    limit: number,
    beforeMessageId: number | null
  ): StoredCodingMessage[] {
    const rows: unknown = this.listMessagesDescStmt.all(sessionId, beforeMessageId, beforeMessageId, limit + 1)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored coding message rows are invalid')
    }
    return rows.map(mapMessage)
  }
}
