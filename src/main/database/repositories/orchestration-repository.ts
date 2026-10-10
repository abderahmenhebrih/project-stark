import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type {
  OrchestrationRunAction,
  OrchestrationRunStatus,
  OrchestrationStepKind,
  OrchestrationStepStatus
} from '../../../shared/orchestration/types'
import { DatabaseError } from '../errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored orchestration ${what} is invalid`)
  }
  return numeric
}

/** Raw orchestration-run row as stored (snake_case, nullable extras). */
export interface StoredOrchestrationRun {
  readonly id: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly userMessageId: number
  readonly status: OrchestrationRunStatus
  readonly action: OrchestrationRunAction | null
  readonly planSummary: string | null
  readonly finalMessageId: number | null
  readonly errorCategory: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Raw orchestration-step row as stored (snake_case). */
export interface StoredOrchestrationStep {
  readonly id: number
  readonly runId: number
  readonly ordinal: number
  readonly kind: OrchestrationStepKind
  readonly status: OrchestrationStepStatus
  readonly instruction: string | null
  readonly output: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function asNullableText(value: unknown): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new DatabaseError('stored orchestration run row is invalid')
  }
  return value
}

function asNullableId(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number') {
    throw new DatabaseError('stored orchestration run row is invalid')
  }
  return value
}

function mapRun(row: unknown): StoredOrchestrationRun {
  if (!isRecord(row)) {
    throw new DatabaseError('stored orchestration run row is invalid')
  }
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sessionId = row['session_id']
  const userMessageId = row['user_message_id']
  const status = row['status']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof workspaceId !== 'number' ||
    typeof sessionId !== 'number' ||
    typeof userMessageId !== 'number' ||
    typeof status !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored orchestration run row is invalid')
  }
  return {
    id,
    workspaceId,
    sessionId,
    userMessageId,
    status: status as OrchestrationRunStatus,
    action: asNullableText(row['action']) as OrchestrationRunAction | null,
    planSummary: asNullableText(row['plan_summary']),
    finalMessageId: asNullableId(row['final_message_id']),
    errorCategory: asNullableText(row['error_category']),
    createdAt,
    updatedAt
  }
}

/** Raw step-model audit row as stored. */
export interface StoredStepModel {
  readonly stepId: number
  readonly role: string
  readonly providerId: string
  readonly model: string
  readonly routeKey: string
  readonly requestedProfile: string | null
}

function mapStepModel(row: unknown): StoredStepModel {
  if (!isRecord(row)) {
    throw new DatabaseError('stored orchestration step model row is invalid')
  }
  const stepId = row['step_id']
  const role = row['role']
  const providerId = row['provider_id']
  const model = row['model']
  const routeKey = row['route_key']
  const requestedProfile = row['requested_profile']
  if (
    typeof stepId !== 'number' ||
    typeof role !== 'string' ||
    typeof providerId !== 'string' ||
    typeof model !== 'string' ||
    typeof routeKey !== 'string' ||
    (requestedProfile !== null && typeof requestedProfile !== 'string')
  ) {
    throw new DatabaseError('stored orchestration step model row is invalid')
  }
  return { stepId, role, providerId, model, routeKey, requestedProfile }
}

function mapStep(row: unknown): StoredOrchestrationStep {
  if (!isRecord(row)) {
    throw new DatabaseError('stored orchestration step row is invalid')
  }
  const id = row['id']
  const runId = row['run_id']
  const ordinal = row['ordinal']
  const kind = row['kind']
  const status = row['status']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' ||
    typeof runId !== 'number' ||
    typeof ordinal !== 'number' ||
    typeof kind !== 'string' ||
    typeof status !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored orchestration step row is invalid')
  }
  return {
    id,
    runId,
    ordinal,
    kind: kind as OrchestrationStepKind,
    status: status as OrchestrationStepStatus,
    instruction: asNullableText(row['instruction']),
    output: asNullableText(row['output']),
    createdAt,
    updatedAt
  }
}

/**
 * Typed main-process repository over orchestration_runs,
 * orchestration_steps, and the final coding_messages row.
 * Persistence only: no provider logic, no filesystem. Every statement
 * is prepared once with parameter binding.
 */
export class OrchestrationRepository {
  private readonly db: DatabaseSync
  private readonly insertRunStmt: StatementSync
  private readonly insertStepStmt: StatementSync
  private readonly insertStepModelStmt: StatementSync
  private readonly findRunStmt: StatementSync
  private readonly findStepsStmt: StatementSync
  private readonly findStepModelsStmt: StatementSync
  private readonly listRecentStmt: StatementSync
  private readonly updateRunStmt: StatementSync
  private readonly touchSessionStmt: StatementSync
  private readonly consumeLooplinkStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertRunStmt = db.prepare(
      'INSERT INTO orchestration_runs ' +
        '(workspace_id, session_id, user_message_id, status, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.insertStepStmt = db.prepare(
      'INSERT INTO orchestration_steps ' +
        '(run_id, ordinal, kind, status, instruction, output, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.insertStepModelStmt = db.prepare(
      'INSERT INTO orchestration_step_models ' +
        '(step_id, role, provider_id, model, route_key, requested_profile) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    )
    this.findRunStmt = db.prepare(
      'SELECT id, workspace_id, session_id, user_message_id, status, action, plan_summary, ' +
        'final_message_id, error_category, created_at, updated_at FROM orchestration_runs WHERE id = ?'
    )
    this.findStepsStmt = db.prepare(
      'SELECT id, run_id, ordinal, kind, status, instruction, output, created_at, updated_at ' +
        'FROM orchestration_steps WHERE run_id = ? ORDER BY ordinal ASC'
    )
    this.findStepModelsStmt = db.prepare(
      'SELECT step_id, role, provider_id, model, route_key, requested_profile ' +
        'FROM orchestration_step_models WHERE step_id IN (SELECT id FROM orchestration_steps WHERE run_id = ?)'
    )
    this.listRecentStmt = db.prepare(
      'SELECT id, workspace_id, session_id, user_message_id, status, action, plan_summary, ' +
        'final_message_id, error_category, created_at, updated_at FROM orchestration_runs ' +
        'WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    this.updateRunStmt = db.prepare(
      'UPDATE orchestration_runs SET status = ?, action = ?, plan_summary = ?, ' +
        'final_message_id = ?, error_category = ?, updated_at = ? WHERE id = ?'
    )
    this.touchSessionStmt = db.prepare('UPDATE coding_sessions SET updated_at = ? WHERE id = ?')
    this.consumeLooplinkStmt = db.prepare(
      "UPDATE looplink_handoffs SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'"
    )
  }

  /** Creates a running run and returns its id. */
  createRun(input: { workspaceId: number; sessionId: number; userMessageId: number; now: number }): number {
    const result = this.insertRunStmt.run(
      input.workspaceId,
      input.sessionId,
      input.userMessageId,
      'running',
      input.now,
      input.now
    )
    return toRowId(result.lastInsertRowid, 'run')
  }

  /** Appends one bounded step and returns its id. */
  appendStep(input: {
    runId: number
    ordinal: number
    kind: OrchestrationStepKind
    status: OrchestrationStepStatus
    instruction: string | null
    output: string | null
    now: number
  }): number {
    const result = this.insertStepStmt.run(
      input.runId,
      input.ordinal,
      input.kind,
      input.status,
      input.instruction,
      input.output,
      input.now,
      input.now
    )
    return toRowId(result.lastInsertRowid, 'step')
  }

  /** Finds one run by id, or undefined. */
  findRunById(id: number): StoredOrchestrationRun | undefined {
    const row: unknown = this.findRunStmt.get(id)
    return row === undefined ? undefined : mapRun(row)
  }

  /** All steps for one run, ordinal order. */
  findSteps(runId: number): StoredOrchestrationStep[] {
    const rows: unknown = this.findStepsStmt.all(runId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored orchestration step rows are invalid')
    }
    return rows.map(mapStep)
  }

  /** Model audit rows for one run's steps, keyed by step id. */
  findStepModels(runId: number): Map<number, StoredStepModel> {
    const rows: unknown = this.findStepModelsStmt.all(runId)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored orchestration step model rows are invalid')
    }
    const mapped = new Map<number, StoredStepModel>()
    for (const row of rows.map(mapStepModel)) {
      mapped.set(row.stepId, row)
    }
    return mapped
  }

  /**
   * Appends one step plus its routing audit atomically: no step
   * without its metadata for provider-backed Stage 19 steps. The
   * optional fault injects a throw between the two inserts for
   * tests only.
   */
  appendStepWithModel(
    input: {
      runId: number
      ordinal: number
      kind: OrchestrationStepKind
      status: OrchestrationStepStatus
      instruction: string | null
      output: string | null
      now: number
    },
    model: {
      role: string
      providerId: string
      model: string
      routeKey: string
      requestedProfile: string | null
    },
    fault?: { readonly failAfterStep: boolean }
  ): number {
    let stepId: number
    this.db.exec('BEGIN')
    try {
      const result = this.insertStepStmt.run(
        input.runId,
        input.ordinal,
        input.kind,
        input.status,
        input.instruction,
        input.output,
        input.now,
        input.now
      )
      stepId = toRowId(result.lastInsertRowid, 'step')
      if (fault?.failAfterStep === true) {
        throw new DatabaseError('injected step-model persistence fault')
      }
      this.insertStepModelStmt.run(
        stepId,
        model.role,
        model.providerId,
        model.model,
        model.routeKey,
        model.requestedProfile
      )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort: the original persistence error below is what matters.
      }
      throw error
    }
    return stepId
  }

  /** Newest-first runs for one session, capped by limit. */
  listRecentForSession(sessionId: number, limit: number): StoredOrchestrationRun[] {
    const rows: unknown = this.listRecentStmt.all(sessionId, limit)
    if (!Array.isArray(rows)) {
      throw new DatabaseError('stored orchestration run rows are invalid')
    }
    return rows.map(mapRun)
  }

  /**
   * Writes the run's terminal state (status, action, summary, final
   * message link, error category) plus its timestamp.
   */
  updateRunState(input: {
    id: number
    status: OrchestrationRunStatus
    action: OrchestrationRunAction | null
    planSummary: string | null
    finalMessageId: number | null
    errorCategory: string | null
    now: number
  }): void {
    this.updateRunStmt.run(
      input.status,
      input.action,
      input.planSummary,
      input.finalMessageId,
      input.errorCategory,
      input.now,
      input.id
    )
  }

  /**
   * Atomically persists the final assistant message, links it to the
   * run, and marks the run completed with its action and plan
   * summary. Either everything lands or nothing does — a completed
   * run without its message (or vice versa) is impossible. The
   * optional fault injects a throw mid-transaction for tests only.
   * When a pending Looplink id is supplied, it is consumed in the
   * same transaction; a non-pending handoff aborts everything so
   * continuity is never lost without its assistant result.
   */
  completeRunWithAssistantMessage(
    input: {
      runId: number
      sessionId: number
      content: string
      action: OrchestrationRunAction
      planSummary: string
      now: number
    },
    options?: { readonly failAfterMessage?: boolean; readonly consumeLooplinkId?: number }
  ): { messageId: number } {
    return this.completeRunWithAssistantMessageAndAttachments(input, [], options)
  }

  /**
   * Step 5 variant: persists the final assistant message together
   * with its generated-image attachment links (same v19
   * message_attachments table — no schema change), links the message
   * to the run, and marks the run completed — all atomically. Either
   * everything lands or nothing does.
   */
  completeRunWithAssistantMessageAndAttachments(
    input: {
      runId: number
      sessionId: number
      content: string
      action: OrchestrationRunAction
      planSummary: string
      now: number
    },
    attachments: readonly {
      readonly attachmentId: string
      readonly originalName: string
      readonly mimeType: string
      readonly sizeBytes: number
      readonly kind: 'image' | 'file'
      readonly sha256: string
      readonly createdAt: number
    }[],
    options?: { readonly failAfterMessage?: boolean; readonly consumeLooplinkId?: number }
  ): { messageId: number } {
    let messageId: number
    this.db.exec('BEGIN')
    try {
      const inserted = this.db
        .prepare('INSERT INTO coding_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        .run(input.sessionId, 'assistant', input.content, input.now)
      messageId = toRowId(inserted.lastInsertRowid, 'message')
      if (options?.failAfterMessage === true) {
        throw new DatabaseError('injected orchestration completion fault')
      }
      for (const attachment of attachments) {
        this.db
          .prepare(
            'INSERT INTO message_attachments ' +
              '(message_id, attachment_id, original_name, mime_type, size_bytes, kind, sha256, created_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
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
      this.updateRunStmt.run('completed', input.action, input.planSummary, messageId, null, input.now, input.runId)
      this.touchSessionStmt.run(input.now, input.sessionId)
      if (options?.consumeLooplinkId !== undefined) {
        const transitioned = this.consumeLooplinkStmt.run(input.now, options.consumeLooplinkId)
        const changed = typeof transitioned.changes === 'bigint' ? Number(transitioned.changes) : transitioned.changes
        if (changed === 0) {
          throw new DatabaseError('looplink is no longer pending')
        }
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

  /** Marks a run failed with a safe error category. */
  failRun(id: number, errorCategory: string, now: number): void {
    const current = this.findRunById(id)
    this.updateRunStmt.run(
      'failed',
      current?.action ?? null,
      current?.planSummary ?? null,
      current?.finalMessageId ?? null,
      errorCategory,
      now,
      id
    )
  }

  /**
   * One bounded crash-recovery pass: marks every leftover `running`
   * run as `interrupted`. Returns the count transitioned. Run once at
   * startup; no resume, no continuation.
   */
  markRunningAsInterrupted(now: number): number {
    const result = this.db
      .prepare("UPDATE orchestration_runs SET status = ?, updated_at = ? WHERE status = 'running'")
      .run('interrupted', now)
    const changed = result.changes
    return typeof changed === 'bigint' ? Number(changed) : changed
  }
}
