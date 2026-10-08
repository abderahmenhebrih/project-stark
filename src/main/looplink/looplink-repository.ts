import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { LooplinkStatus } from '../../shared/looplink/types'
import { DatabaseError } from '../database/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored looplink ${what} is invalid`)
  }
  return numeric
}

function asNullableNumber(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number') {
    throw new DatabaseError('stored looplink row is invalid')
  }
  return value
}

/** Raw handoff row as stored (snake_case). */
export interface StoredLooplinkHandoff {
  readonly id: number
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly targetSessionId: number
  readonly sourceRunId: number | null
  readonly status: LooplinkStatus
  readonly payload: string
  readonly payloadBytes: number
  readonly payloadHash: string
  readonly omittedMessageCount: number
  readonly omittedContextCount: number
  readonly workerResultOmitted: boolean
  readonly omittedChangeCount: number
  readonly createdAt: number
  readonly consumedAt: number | null
  readonly dismissedAt: number | null
}

function mapHandoff(row: unknown): StoredLooplinkHandoff {
  if (!isRecord(row)) {
    throw new DatabaseError('stored looplink row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sourceSessionId = row['source_session_id']
  const targetSessionId = row['target_session_id']
  const sourceRunId = row['source_run_id']
  const status = row['status']
  const payload = row['payload']
  const payloadBytes = row['payload_bytes']
  const payloadHash = row['payload_hash']
  const omittedMessageCount = row['omitted_message_count']
  const omittedContextCount = row['omitted_context_count']
  const workerResultOmitted = row['worker_result_omitted']
  const omittedChangeCount = row['omitted_change_count']
  const createdAt = row['created_at']
  const consumedAt = row['consumed_at']
  const dismissedAt = row['dismissed_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof sourceSessionId !== 'number' ||
    typeof targetSessionId !== 'number' ||
    (sourceRunId !== null && typeof sourceRunId !== 'number') ||
    typeof status !== 'string' ||
    typeof payload !== 'string' ||
    typeof payloadBytes !== 'number' ||
    typeof payloadHash !== 'string' ||
    typeof omittedMessageCount !== 'number' ||
    typeof omittedContextCount !== 'number' ||
    (workerResultOmitted !== 0 && workerResultOmitted !== 1) ||
    typeof omittedChangeCount !== 'number' ||
    typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored looplink row is invalid')
  }
  return {
    id,
    workspaceId,
    sourceSessionId,
    targetSessionId,
    sourceRunId,
    status: status as LooplinkStatus,
    payload,
    payloadBytes,
    payloadHash,
    omittedMessageCount,
    omittedContextCount,
    workerResultOmitted: workerResultOmitted === 1,
    omittedChangeCount,
    createdAt,
    consumedAt: asNullableNumber(consumedAt),
    dismissedAt: asNullableNumber(dismissedAt)
  }
}

/**
 * Typed main-process repository over looplink_handoffs plus the target
 * coding_sessions row and the assistant coding_messages row. No
 * provider logic, no filesystem. Multi-row mutations run in ONE
 * SQLite transaction each.
 */
export class LooplinkRepository {
  private readonly db: DatabaseSync
  private readonly insertSessionStmt: StatementSync
  private readonly insertHandoffStmt: StatementSync
  private readonly findByIdStmt: StatementSync
  private readonly findByTargetStmt: StatementSync
  private readonly listFromSourceStmt: StatementSync
  private readonly transitionStmt: StatementSync
  private readonly insertMessageStmt: StatementSync
  private readonly touchSessionStmt: StatementSync
  private readonly retitleSessionStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertSessionStmt = db.prepare(
      'INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
    this.insertHandoffStmt = db.prepare(
      'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, source_run_id, status, ' +
        'payload, payload_bytes, payload_hash, omitted_message_count, omitted_context_count, ' +
        'worker_result_omitted, omitted_change_count, created_at, consumed_at, dismissed_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.findByIdStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_run_id, status, payload, ' +
        'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
        'omitted_change_count, created_at, consumed_at, dismissed_at FROM looplink_handoffs WHERE id = ?'
    )
    this.findByTargetStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_run_id, status, payload, ' +
        'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
        'omitted_change_count, created_at, consumed_at, dismissed_at FROM looplink_handoffs WHERE target_session_id = ?'
    )
    this.listFromSourceStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_run_id, status, payload, ' +
        'payload_bytes, payload_hash, omitted_message_count, omitted_context_count, worker_result_omitted, ' +
        'omitted_change_count, created_at, consumed_at, dismissed_at FROM looplink_handoffs ' +
        'WHERE source_session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    this.transitionStmt = db.prepare(
      'UPDATE looplink_handoffs SET status = ?, consumed_at = ?, dismissed_at = ? WHERE id = ? AND status = ?'
    )
    this.insertMessageStmt = db.prepare(
      'INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )
    this.touchSessionStmt = db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?')
    this.retitleSessionStmt = db.prepare(
      'UPDATE coding_sessions SET updated_at = ?, title = ? WHERE id = ? AND title = ?'
    )
  }

  /**
   * Atomically creates the target session plus its pending handoff.
   * Either both exist or neither does. The optional fault injects a
   * throw between the two inserts for tests only.
   */
  createContinuation(
    input: {
      workspaceId: number
      sourceSessionId: number
      targetTitle: string
      sourceRunId: number | null
      payload: string
      payloadBytes: number
      payloadHash: string
      omittedMessageCount: number
      omittedContextCount: number
      workerResultOmitted: boolean
      omittedChangeCount: number
      now: number
    },
    fault?: { readonly failAfterSession: boolean }
  ): { targetSessionId: number; handoffId: number } {
    let targetSessionId: number
    let handoffId: number
    this.db.exec('BEGIN')
    try {
      const sessionResult = this.insertSessionStmt.run(input.workspaceId, input.targetTitle, input.now, input.now)
      targetSessionId = toRowId(sessionResult.lastInsertRowid, 'session')
      if (fault?.failAfterSession === true) {
        throw new DatabaseError('injected looplink creation fault')
      }
      const handoffResult = this.insertHandoffStmt.run(
        input.workspaceId,
        input.sourceSessionId,
        targetSessionId,
        input.sourceRunId,
        'pending',
        input.payload,
        input.payloadBytes,
        input.payloadHash,
        input.omittedMessageCount,
        input.omittedContextCount,
        input.workerResultOmitted ? 1 : 0,
        input.omittedChangeCount,
        input.now,
        null,
        null
      )
      handoffId = toRowId(handoffResult.lastInsertRowid, 'handoff')
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return { targetSessionId, handoffId }
  }

  /** Finds one handoff by id, or undefined. */
  findById(id: number): StoredLooplinkHandoff | undefined {
    const row: unknown = this.findByIdStmt.get(id)
    return row === undefined ? undefined : mapHandoff(row)
  }

  /** Finds the handoff attached to one target session, or undefined. */
  findByTargetSession(targetSessionId: number): StoredLooplinkHandoff | undefined {
    const row: unknown = this.findByTargetStmt.get(targetSessionId)
    return row === undefined ? undefined : mapHandoff(row)
  }

  /** Newest-first handoffs created from one source session, capped. */
  listRecentFromSource(sourceSessionId: number, limit: number): StoredLooplinkHandoff[] {
    const rows: unknown = this.listFromSourceStmt.all(sourceSessionId, limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored looplink rows are invalid')
    }
    return rows.map(mapHandoff)
  }

  /**
   * Transitions pending → consumed or pending → dismissed, recording
   * the timestamp. Returns false when the handoff was not pending.
   */
  transition(id: number, to: 'consumed' | 'dismissed', now: number): boolean {
    const stamped = to === 'consumed' ? { consumed: now, dismissed: null } : { consumed: null, dismissed: now }
    const result = this.transitionStmt.run(to, stamped.consumed, stamped.dismissed, id, 'pending')
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /**
   * Atomically persists one assistant message, advances the session
   * timestamp (plus the conditional first-message retitle, mirroring
   * the session repository), and consumes the handoff. Either all
   * three land or none does. The optional fault injects a throw
   * mid-transaction for tests only.
   */
  appendAssistantMessageAndConsume(
    input: {
      sessionId: number
      content: string
      now: number
      looplinkId: number
      retitle: { readonly expectedTitle: string; readonly newTitle: string } | null
    },
    fault?: { readonly failAfterMessage: boolean }
  ): { messageId: number } {
    let messageId: number
    this.db.exec('BEGIN')
    try {
      const inserted = this.insertMessageStmt.run(input.sessionId, 'assistant', input.content, input.now)
      messageId = toRowId(inserted.lastInsertRowid, 'message')
      if (fault?.failAfterMessage === true) {
        throw new DatabaseError('injected looplink completion fault')
      }
      if (input.retitle !== null) {
        const updated = this.retitleSessionStmt.run(input.now, input.retitle.newTitle, input.sessionId, input.retitle.expectedTitle)
        const changed = typeof updated.changes === 'bigint' ? Number(updated.changes) : updated.changes
        if (changed === 0) {
          this.touchSessionStmt.run(input.now, input.sessionId)
        }
      } else {
        this.touchSessionStmt.run(input.now, input.sessionId)
      }
      const transitioned = this.transitionStmt.run('consumed', input.now, null, input.looplinkId, 'pending')
      const changed = typeof transitioned.changes === 'bigint' ? Number(transitioned.changes) : transitioned.changes
      if (changed === 0) {
        throw new DatabaseError('looplink is no longer pending')
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
    return { messageId }
  }
}
