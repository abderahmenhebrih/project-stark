import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { RecoveryEventRoute, RecoveryEventStatus, RecoveryOperation } from '../../shared/recovery/types'
import { DatabaseError } from '../database/errors'
import { MAX_SESSION_TITLE_CODEPOINTS } from '../sessions/limits'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored recovery ${what} is invalid`)
  }
  return numeric
}

function asNullableNumber(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number') {
    throw new DatabaseError('stored recovery row is invalid')
  }
  return value
}

/** Raw recovery settings row (singleton id = 1). */
export interface StoredRecoverySettings {
  readonly mode: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw recovery assignment row. */
export interface StoredRecoveryAssignment {
  readonly role: string
  readonly providerId: string
  readonly model: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw recovery event row as stored (snake_case). */
export interface StoredRecoveryEvent {
  readonly id: number
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly targetSessionId: number
  readonly sourceMessageId: number
  readonly looplinkHandoffId: number
  readonly operation: string
  readonly failureCategory: string
  readonly policyMode: string
  readonly status: string
  readonly attemptCount: number
  readonly targetUserMessageId: number | null
  readonly targetAssistantMessageId: number | null
  readonly targetRunId: number | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

function mapSettings(row: unknown): StoredRecoverySettings {
  if (!isRecord(row)) {
    throw new DatabaseError('stored recovery settings row is invalid')
  }
  const mode = row['mode']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (typeof mode !== 'string' || typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
    throw new DatabaseError('stored recovery settings row is invalid')
  }
  return { mode, createdAt, updatedAt }
}

function mapAssignment(row: unknown): StoredRecoveryAssignment {
  if (!isRecord(row)) {
    throw new DatabaseError('stored recovery assignment row is invalid')
  }
  const role = row['role']
  const providerId = row['provider_id']
  const model = row['model']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof role !== 'string' ||
    typeof providerId !== 'string' ||
    typeof model !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored recovery assignment row is invalid')
  }
  return { role, providerId, model, createdAt, updatedAt }
}

function mapEvent(row: unknown): StoredRecoveryEvent {
  if (!isRecord(row)) {
    throw new DatabaseError('stored recovery event row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sourceSessionId = row['source_session_id']
  const targetSessionId = row['target_session_id']
  const sourceMessageId = row['source_message_id']
  const looplinkHandoffId = row['looplink_handoff_id']
  const operation = row['operation']
  const failureCategory = row['failure_category']
  const policyMode = row['policy_mode']
  const status = row['status']
  const attemptCount = row['attempt_count']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof sourceSessionId !== 'number' ||
    typeof targetSessionId !== 'number' ||
    typeof sourceMessageId !== 'number' ||
    typeof looplinkHandoffId !== 'number' ||
    typeof operation !== 'string' ||
    typeof failureCategory !== 'string' ||
    typeof policyMode !== 'string' ||
    typeof status !== 'string' ||
    typeof attemptCount !== 'number' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored recovery event row is invalid')
  }
  return {
    id,
    workspaceId,
    sourceSessionId,
    targetSessionId,
    sourceMessageId,
    looplinkHandoffId,
    operation,
    failureCategory,
    policyMode,
    status,
    attemptCount,
    targetUserMessageId: asNullableNumber(row['target_user_message_id']),
    targetAssistantMessageId: asNullableNumber(row['target_assistant_message_id']),
    targetRunId: asNullableNumber(row['target_run_id']),
    createdAt,
    updatedAt,
    completedAt: asNullableNumber(row['completed_at'])
  }
}

function mapRoute(row: unknown): RecoveryEventRoute {
  if (!isRecord(row)) {
    throw new DatabaseError('stored recovery route row is invalid')
  }
  const role = row['role']
  const providerId = row['provider_id']
  const model = row['model']
  if (typeof role !== 'string' || typeof providerId !== 'string' || typeof model !== 'string') {
    throw new DatabaseError('stored recovery route row is invalid')
  }
  return { role: role as RecoveryEventRoute['role'], providerId, model }
}

function countCodePoints(value: string): number {
  return [...value].length
}

/** Recovery target title reusing the session 80-codepoint bound. */
export function deriveRecoveryTitle(sourceTitle: string): string {
  const collapsed = `Recovery: ${sourceTitle}`.trim().replace(/\s+/g, ' ')
  if (countCodePoints(collapsed) <= MAX_SESSION_TITLE_CODEPOINTS) {
    return collapsed
  }
  return `${[...collapsed].slice(0, MAX_SESSION_TITLE_CODEPOINTS).join('')}…`
}

export interface RecoveryAggregateInput {
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly sourceMessageId: number
  readonly operation: RecoveryOperation
  readonly failureCategory: string
  readonly policyMode: string
  readonly status: RecoveryEventStatus
  readonly attemptCount: number
  readonly targetTitle: string
  readonly sourceRunId: number | null
  readonly payload: string
  readonly payloadBytes: number
  readonly payloadHash: string
  readonly omittedMessageCount: number
  readonly omittedContextCount: number
  readonly workerResultOmitted: boolean
  readonly omittedChangeCount: number
  /** Null for handoff (no replay); exact source text for auto_once. */
  readonly replayText: string | null
  readonly routes: readonly { role: string; providerId: string; model: string }[]
  readonly now: number
}

/**
 * Typed main-process repository over ai_recovery_settings,
 * ai_recovery_assignments, ai_recovery_events, and
 * ai_recovery_event_routes — plus the atomic target aggregate
 * (session + handoff + event + replay + routes) and atomic final
 * completions. Persistence only: no validation beyond row shapes,
 * no provider logic, no credentials anywhere.
 */
export class RecoveryRepository {
  private readonly db: DatabaseSync
  private readonly findSettingsStmt: StatementSync
  private readonly upsertSettingsStmt: StatementSync
  private readonly listAssignmentsStmt: StatementSync
  private readonly upsertAssignmentStmt: StatementSync
  private readonly deleteAssignmentStmt: StatementSync
  private readonly findEventBySourceStmt: StatementSync
  private readonly findEventByTargetStmt: StatementSync
  private readonly findEventByHandoffStmt: StatementSync
  private readonly findEventByIdStmt: StatementSync
  private readonly listRoutesStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.findSettingsStmt = db.prepare('SELECT mode, created_at, updated_at FROM ai_recovery_settings WHERE id = 1')
    this.upsertSettingsStmt = db.prepare(
      'INSERT INTO ai_recovery_settings (id, mode, created_at, updated_at) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at'
    )
    this.listAssignmentsStmt = db.prepare(
      'SELECT role, provider_id, model, created_at, updated_at FROM ai_recovery_assignments'
    )
    this.upsertAssignmentStmt = db.prepare(
      'INSERT INTO ai_recovery_assignments (role, provider_id, model, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, ' +
        'updated_at = excluded.updated_at'
    )
    this.deleteAssignmentStmt = db.prepare('DELETE FROM ai_recovery_assignments WHERE role = ?')
    this.findEventBySourceStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_message_id, looplink_handoff_id, ' +
        'operation, failure_category, policy_mode, status, attempt_count, target_user_message_id, ' +
        'target_assistant_message_id, target_run_id, created_at, updated_at, completed_at ' +
        'FROM ai_recovery_events WHERE source_session_id = ? AND source_message_id = ? AND operation = ?'
    )
    this.findEventByTargetStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_message_id, looplink_handoff_id, ' +
        'operation, failure_category, policy_mode, status, attempt_count, target_user_message_id, ' +
        'target_assistant_message_id, target_run_id, created_at, updated_at, completed_at ' +
        'FROM ai_recovery_events WHERE target_session_id = ?'
    )
    this.findEventByHandoffStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_message_id, looplink_handoff_id, ' +
        'operation, failure_category, policy_mode, status, attempt_count, target_user_message_id, ' +
        'target_assistant_message_id, target_run_id, created_at, updated_at, completed_at ' +
        'FROM ai_recovery_events WHERE looplink_handoff_id = ?'
    )
    this.findEventByIdStmt = db.prepare(
      'SELECT id, workspace_id, source_session_id, target_session_id, source_message_id, looplink_handoff_id, ' +
        'operation, failure_category, policy_mode, status, attempt_count, target_user_message_id, ' +
        'target_assistant_message_id, target_run_id, created_at, updated_at, completed_at ' +
        'FROM ai_recovery_events WHERE id = ?'
    )
    this.listRoutesStmt = db.prepare(
      'SELECT role, provider_id, model FROM ai_recovery_event_routes WHERE recovery_event_id = ?'
    )
  }

  /** Active settings row, or undefined when recovery was never configured. */
  findSettings(): StoredRecoverySettings | undefined {
    const row: unknown = this.findSettingsStmt.get()
    return row === undefined ? undefined : mapSettings(row)
  }

  /** All stored assignments. */
  listAssignments(): StoredRecoveryAssignment[] {
    const rows: unknown = this.listAssignmentsStmt.all()
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored recovery assignment rows are invalid')
    }
    return rows.map(mapAssignment)
  }

  /**
   * Atomically replaces the complete recovery configuration: settings
   * plus exactly the given assignments (stale rows removed).
   */
  saveConfig(
    input: {
      mode: string
      assignments: { role: string; providerId: string; model: string }[]
      now: number
    },
    fault?: { readonly failAfterAssignments: number }
  ): void {
    this.db.exec('BEGIN')
    try {
      this.upsertSettingsStmt.run(input.mode, input.now, input.now)
      const wanted = new Set(input.assignments.map((entry) => entry.role))
      for (const existing of this.listAssignments()) {
        if (!wanted.has(existing.role)) {
          this.deleteAssignmentStmt.run(existing.role)
        }
      }
      let inserted = 0
      for (const entry of input.assignments) {
        this.upsertAssignmentStmt.run(entry.role, entry.providerId, entry.model, input.now, input.now)
        inserted += 1
        if (fault !== undefined && inserted > fault.failAfterAssignments) {
          throw new DatabaseError('injected recovery save fault')
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
  }

  /** Finds one event by its source tuple, or undefined. */
  findEventBySource(sourceSessionId: number, sourceMessageId: number, operation: string): StoredRecoveryEvent | undefined {
    const row: unknown = this.findEventBySourceStmt.get(sourceSessionId, sourceMessageId, operation)
    return row === undefined ? undefined : mapEvent(row)
  }

  /** Finds the event whose target is the given session, or undefined. */
  findEventByTarget(targetSessionId: number): StoredRecoveryEvent | undefined {
    const row: unknown = this.findEventByTargetStmt.get(targetSessionId)
    return row === undefined ? undefined : mapEvent(row)
  }

  /** Finds one event by its looplink handoff id, or undefined. */
  findEventByHandoff(handoffId: number): StoredRecoveryEvent | undefined {
    const row: unknown = this.findEventByHandoffStmt.get(handoffId)
    return row === undefined ? undefined : mapEvent(row)
  }

  /** Finds one event by id, or undefined. */
  findEventById(id: number): StoredRecoveryEvent | undefined {
    const row: unknown = this.findEventByIdStmt.get(id)
    return row === undefined ? undefined : mapEvent(row)
  }

  /** All route rows for one event. */
  listRoutes(eventId: number): RecoveryEventRoute[] {
    const rows: unknown = this.listRoutesStmt.all(eventId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored recovery route rows are invalid')
    }
    return rows.map(mapRoute)
  }

  /**
   * Records a successful recovery outcome after the recovery Ask/Work
   * path already persisted its assistant message (and, for Work, its
   * completed run) plus Looplink consumption atomically. Only a
   * `running` event advances to `succeeded` — handoff_ready, failed,
   * dismissed, and interrupted rows never transition here.
   */
  markAskSucceeded(eventId: number, assistantMessageId: number, now: number): void {
    this.db
      .prepare(
        "UPDATE ai_recovery_events SET status = 'succeeded', target_assistant_message_id = ?, " +
          'attempt_count = 1, updated_at = ?, completed_at = ? WHERE id = ? AND status = ?'
      )
      .run(assistantMessageId, now, now, eventId, 'running')
  }

  /** Records a successful Work recovery outcome (running → succeeded). */
  markWorkSucceeded(eventId: number, assistantMessageId: number, runId: number, now: number): void {
    this.db
      .prepare(
        'UPDATE ai_recovery_events SET status = ?, target_assistant_message_id = ?, target_run_id = ?, ' +
          'attempt_count = 1, updated_at = ?, completed_at = ? WHERE id = ? AND status = ?'
      )
      .run('succeeded', assistantMessageId, runId, now, now, eventId, 'running')
  }

  /**
   * Atomically creates the full recovery target aggregate: target
   * session + pending Looplink handoff + recovery event + optional
   * replay user message + route audit rows. Either everything lands or
   * nothing does. Fault injection is test-only.
   */
  createTargetAggregate(
    input: RecoveryAggregateInput,
    fault?: { readonly failAfterSession?: boolean; readonly failAfterHandoff?: boolean; readonly failAfterMessage?: boolean }
  ): { targetSessionId: number; handoffId: number; eventId: number; targetUserMessageId: number | null } {
    let targetSessionId: number
    let handoffId: number
    let eventId: number
    let targetUserMessageId: number | null = null
    this.db.exec('BEGIN')
    try {
      const sessionResult = this.db
        .prepare('INSERT INTO coding_sessions (workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(input.workspaceId, input.targetTitle, input.now, input.now)
      targetSessionId = toRowId(sessionResult.lastInsertRowid, 'session')
      if (fault?.failAfterSession === true) {
        throw new DatabaseError('injected recovery creation fault')
      }
      const handoffResult = this.db
        .prepare(
          'INSERT INTO looplink_handoffs (workspace_id, source_session_id, target_session_id, source_run_id, status, ' +
            'payload, payload_bytes, payload_hash, omitted_message_count, omitted_context_count, ' +
            'worker_result_omitted, omitted_change_count, created_at, consumed_at, dismissed_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
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
      if (fault?.failAfterHandoff === true) {
        throw new DatabaseError('injected recovery creation fault')
      }
      if (input.replayText !== null) {
        const messageResult = this.db
          .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
          .run(targetSessionId, 'user', input.replayText, input.now)
        targetUserMessageId = toRowId(messageResult.lastInsertRowid, 'message')
        this.db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?').run(input.now, targetSessionId)
        if (fault?.failAfterMessage === true) {
          throw new DatabaseError('injected recovery creation fault')
        }
      }
      const eventResult = this.db
        .prepare(
          'INSERT INTO ai_recovery_events (workspace_id, source_session_id, target_session_id, source_message_id, ' +
            'looplink_handoff_id, operation, failure_category, policy_mode, status, attempt_count, ' +
            'target_user_message_id, target_assistant_message_id, target_run_id, created_at, updated_at, completed_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          input.workspaceId,
          input.sourceSessionId,
          targetSessionId,
          input.sourceMessageId,
          handoffId,
          input.operation,
          input.failureCategory,
          input.policyMode,
          input.status,
          input.attemptCount,
          targetUserMessageId,
          null,
          null,
          input.now,
          input.now,
          null
        )
      eventId = toRowId(eventResult.lastInsertRowid, 'event')
      for (const route of input.routes) {
        this.db
          .prepare(
            'INSERT INTO ai_recovery_event_routes (recovery_event_id, role, provider_id, model) VALUES (?, ?, ?, ?)'
          )
          .run(eventId, route.role, route.providerId, route.model)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
    return { targetSessionId, handoffId, eventId, targetUserMessageId }
  }

  /**
   * Atomically completes an Ask recovery: assistant message + session
   * touch + Looplink consume + event success. Either all or none.
   */
  completeAskSuccess(
    input: { eventId: number; looplinkId: number; targetSessionId: number; content: string; now: number },
    fault?: { readonly failAfterMessage: boolean }
  ): { messageId: number } {
    let messageId: number
    this.db.exec('BEGIN')
    try {
      const inserted = this.db
        .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .run(input.targetSessionId, 'assistant', input.content, input.now)
      messageId = toRowId(inserted.lastInsertRowid, 'message')
      if (fault?.failAfterMessage === true) {
        throw new DatabaseError('injected recovery completion fault')
      }
      this.db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?').run(input.now, input.targetSessionId)
      const consumed = this.db
        .prepare("UPDATE looplink_handoffs SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'")
        .run(input.now, input.looplinkId)
      const changedConsumed = typeof consumed.changes === 'bigint' ? Number(consumed.changes) : consumed.changes
      if (changedConsumed === 0) {
        throw new DatabaseError('looplink is no longer pending')
      }
      this.db
        .prepare(
          "UPDATE ai_recovery_events SET status = 'succeeded', target_assistant_message_id = ?, " +
            'attempt_count = 1, updated_at = ?, completed_at = ? WHERE id = ?'
        )
        .run(messageId, input.now, input.now, input.eventId)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
    return { messageId }
  }

  /**
   * Atomically completes a Work recovery: assistant message +
   * orchestration completion + session touch + Looplink consume +
   * event success. Either all or none.
   */
  completeWorkSuccess(
    input: {
      eventId: number
      looplinkId: number
      targetSessionId: number
      targetRunId: number
      content: string
      action: string
      planSummary: string
      now: number
    },
    fault?: { readonly failAfterMessage: boolean }
  ): { messageId: number } {
    let messageId: number
    this.db.exec('BEGIN')
    try {
      const inserted = this.db
        .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .run(input.targetSessionId, 'assistant', input.content, input.now)
      messageId = toRowId(inserted.lastInsertRowid, 'message')
      if (fault?.failAfterMessage === true) {
        throw new DatabaseError('injected recovery completion fault')
      }
      this.db
        .prepare(
          'UPDATE orchestration_runs SET status = ?, action = ?, plan_summary = ?, ' +
            'final_message_id = ?, error_category = ?, updated_at = ? WHERE id = ?'
        )
        .run('completed', input.action, input.planSummary, messageId, null, input.now, input.targetRunId)
      this.db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?').run(input.now, input.targetSessionId)
      const consumed = this.db
        .prepare("UPDATE looplink_handoffs SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'")
        .run(input.now, input.looplinkId)
      const changedConsumed = typeof consumed.changes === 'bigint' ? Number(consumed.changes) : consumed.changes
      if (changedConsumed === 0) {
        throw new DatabaseError('looplink is no longer pending')
      }
      this.db
        .prepare(
          'UPDATE ai_recovery_events SET status = ?, target_assistant_message_id = ?, target_run_id = ?, ' +
            'attempt_count = 1, updated_at = ?, completed_at = ? WHERE id = ?'
        )
        .run('succeeded', messageId, input.targetRunId, input.now, input.now, input.eventId)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
    return { messageId }
  }

  /** Marks a recovery event failed (Looplink stays pending, no retry). */
  markFailed(eventId: number, now: number): void {
    this.db
      .prepare("UPDATE ai_recovery_events SET status = 'failed', attempt_count = 1, updated_at = ?, completed_at = ? WHERE id = ?")
      .run(now, now, eventId)
  }

  /** Links a target run to its event (Work recovery before final completion). */
  linkTargetRun(eventId: number, runId: number, now: number): void {
    this.db
      .prepare('UPDATE ai_recovery_events SET target_run_id = ?, updated_at = ? WHERE id = ?')
      .run(runId, now, eventId)
  }

  /**
   * Atomically dismisses a handoff_ready recovery: Looplink
   * pending→dismissed plus event handoff_ready→dismissed. Returns
   * false when the linked rows were not in the expected states.
   */
  dismissHandoffReady(eventId: number, handoffId: number, now: number): boolean {
    let dismissed: boolean
    this.db.exec('BEGIN')
    try {
      const loop = this.db
        .prepare("UPDATE looplink_handoffs SET status = 'dismissed', dismissed_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, handoffId)
      const loopChanged = typeof loop.changes === 'bigint' ? Number(loop.changes) : loop.changes
      const evt = this.db
        .prepare(
          "UPDATE ai_recovery_events SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'handoff_ready'"
        )
        .run(now, eventId)
      const evtChanged = typeof evt.changes === 'bigint' ? Number(evt.changes) : evt.changes
      dismissed = loopChanged !== 0 && evtChanged !== 0
      if (!dismissed) {
        throw new DatabaseError('recovery is no longer dismissible')
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
    return dismissed
  }

  /**
   * One bounded crash-recovery pass: marks every leftover `running`
   * event as `interrupted`. Returns the count transitioned. No
   * provider calls, no resume, no continuation.
   */
  markRunningAsInterrupted(now: number): number {
    const result = this.db
      .prepare("UPDATE ai_recovery_events SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
      .run(now)
    const changed = result.changes
    return typeof changed === 'bigint' ? Number(changed) : changed
  }
}
