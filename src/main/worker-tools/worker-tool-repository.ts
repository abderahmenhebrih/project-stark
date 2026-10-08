import { createHash } from 'node:crypto'
import { TextEncoder } from 'node:util'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'
import { APPROVAL_MAX_AGE_MS, MAX_WORKER_TOOL_STATE_BYTES } from './worker-tool-limits'

const encoder = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored worker tool ${what} is invalid`)
  }
  return numeric
}

function asNullableNumber(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number') throw new DatabaseError('stored worker tool row is invalid')
  return value
}

/** Deterministic JSON serialization (fixed key order at top level). */
export function serializeToolArgs(args: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(args).sort()) {
    ordered[key] = args[key]
  }
  return JSON.stringify(ordered)
}

/** SHA-256 over exact serialized argument bytes. */
export function hashToolArgs(serialized: string): string {
  return createHash('sha256').update(encoder.encode(serialized)).digest('hex')
}

export function hashState(serialized: string): string {
  return createHash('sha256').update(encoder.encode(serialized)).digest('hex')
}

/** Raw approval row. */
export interface StoredToolApproval {
  readonly id: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly runId: number
  readonly toolName: string
  readonly capability: string
  readonly argsJson: string
  readonly argsHash: string
  readonly summary: string
  readonly status: string
  readonly createdAt: number
  readonly decidedAt: number | null
  readonly consumedAt: number | null
}

function mapApproval(row: unknown): StoredToolApproval {
  if (!isRecord(row)) throw new DatabaseError('stored tool approval row is invalid')
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sessionId = row['session_id']
  const runId = row['orchestration_run_id']
  const toolName = row['tool_name']
  const capability = row['capability']
  const argsJson = row['arguments_json']
  const argsHash = row['arguments_hash']
  const summary = row['summary']
  const status = row['status']
  const createdAt = row['created_at']
  if (
    typeof id !== 'number' || typeof workspaceId !== 'number' || typeof sessionId !== 'number' ||
    typeof runId !== 'number' || typeof toolName !== 'string' || typeof capability !== 'string' ||
    typeof argsJson !== 'string' || typeof argsHash !== 'string' || typeof summary !== 'string' ||
    typeof status !== 'string' || typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored tool approval row is invalid')
  }
  return {
    id, workspaceId, sessionId, runId, toolName, capability, argsJson, argsHash, summary, status, createdAt,
    decidedAt: asNullableNumber(row['decided_at']),
    consumedAt: asNullableNumber(row['consumed_at'])
  }
}

/** Raw tool event row. */
export interface StoredToolEvent {
  readonly id: number
  readonly runId: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly toolName: string
  readonly capability: string
  readonly argsJson: string
  readonly summary: string
  readonly payload: string
  readonly bytes: number
  readonly status: string
  readonly approvalId: number | null
  readonly createdAt: number
}

/** Persisted normalized run state for crash-safe resume. */
export interface StoredRunState {
  readonly runId: number
  readonly toolCallCount: number
  readonly workerInstruction: string
  readonly activeUserMessageId: number
  readonly continuityUsed: boolean
  readonly stateJson: string
  readonly stateHash: string
  readonly updatedAt: number
}

/**
 * Typed repository over worker_tool_approvals, worker_tool_events,
 * and worker_tool_run_state. Persistence only — no provider, gate,
 * or filesystem logic. Multi-row mutations run in ONE transaction.
 */
export class WorkerToolRepository {
  private readonly db: DatabaseSync
  private readonly insertApprovalStmt: StatementSync
  private readonly findApprovalStmt: StatementSync
  private readonly findPendingStmt: StatementSync
  private readonly insertEventStmt: StatementSync
  private readonly listEventsStmt: StatementSync
  private readonly upsertStateStmt: StatementSync
  private readonly findStateStmt: StatementSync
  private readonly updateRunStatusStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.insertApprovalStmt = db.prepare(
      'INSERT INTO worker_tool_approvals (workspace_id, session_id, orchestration_run_id, tool_name, capability, ' +
        'arguments_json, arguments_hash, summary, status, created_at, decided_at, consumed_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.findApprovalStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, ' +
        'arguments_hash, summary, status, created_at, decided_at, consumed_at FROM worker_tool_approvals WHERE id = ?'
    )
    this.findPendingStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, ' +
        'arguments_hash, summary, status, created_at, decided_at, consumed_at FROM worker_tool_approvals ' +
        'WHERE session_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    this.insertEventStmt = db.prepare(
      'INSERT INTO worker_tool_events (workspace_id, session_id, orchestration_run_id, tool_name, capability, ' +
        'arguments_json, result_summary, result_payload, result_bytes, status, approval_id, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    this.listEventsStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, tool_name, capability, arguments_json, result_summary, result_payload, ' +
        'result_bytes, status, approval_id, created_at FROM worker_tool_events WHERE orchestration_run_id = ? ORDER BY id ASC'
    )
    this.upsertStateStmt = db.prepare(
      'INSERT INTO worker_tool_run_state (orchestration_run_id, tool_call_count, worker_instruction, ' +
        'active_user_message_id, continuity_used, state_json, state_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(orchestration_run_id) DO UPDATE SET tool_call_count = excluded.tool_call_count, ' +
        'worker_instruction = excluded.worker_instruction, active_user_message_id = excluded.active_user_message_id, ' +
        'continuity_used = excluded.continuity_used, state_json = excluded.state_json, state_hash = excluded.state_hash, ' +
        'updated_at = excluded.updated_at'
    )
    this.findStateStmt = db.prepare(
      'SELECT orchestration_run_id, tool_call_count, worker_instruction, active_user_message_id, continuity_used, ' +
        'state_json, state_hash, updated_at FROM worker_tool_run_state WHERE orchestration_run_id = ?'
    )
    this.updateRunStatusStmt = db.prepare(
      'UPDATE orchestration_runs SET status = ?, updated_at = ? WHERE id = ?'
    )
  }

  /** Finds one approval by id, or undefined. */
  findApproval(id: number): StoredToolApproval | undefined {
    const row: unknown = this.findApprovalStmt.get(id)
    return row === undefined ? undefined : mapApproval(row)
  }

  /** Newest pending approval for one session, or undefined. */
  findPendingForSession(sessionId: number): StoredToolApproval | undefined {
    const row: unknown = this.findPendingStmt.get(sessionId, 'pending')
    return row === undefined ? undefined : mapApproval(row)
  }

  /** True when an unresolved (pending) approval exists for the session. */
  hasPending(sessionId: number): boolean {
    return this.findPendingForSession(sessionId) !== undefined
  }

  /**
   * Atomically creates one approval, persists run state, and parks the
   * run as waiting_for_approval. Either all three land or none does.
   */
  createApprovalAndPark(input: {
    workspaceId: number
    sessionId: number
    runId: number
    toolName: string
    capability: string
    argsJson: string
    argsHash: string
    summary: string
    state: { toolCallCount: number; workerInstruction: string; activeUserMessageId: number; continuityUsed: boolean; stateJson: string; stateHash: string }
    now: number
  }): { approvalId: number } {
    if (encoder.encode(input.state.stateJson).byteLength > MAX_WORKER_TOOL_STATE_BYTES) {
      throw new DatabaseError('worker tool state is too large')
    }
    let approvalId: number
    this.db.exec('BEGIN')
    try {
      const inserted = this.insertApprovalStmt.run(
        input.workspaceId, input.sessionId, input.runId, input.toolName, input.capability,
        input.argsJson, input.argsHash, input.summary, 'pending', input.now, null, null
      )
      approvalId = toRowId(inserted.lastInsertRowid, 'approval')
      this.upsertStateStmt.run(
        input.runId, input.state.toolCallCount, input.state.workerInstruction,
        input.state.activeUserMessageId, input.state.continuityUsed ? 1 : 0,
        input.state.stateJson, input.state.stateHash, input.now
      )
      this.updateRunStatusStmt.run('waiting_for_approval', input.now, input.runId)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Best effort.
      }
      throw error
    }
    return { approvalId }
  }

  /** Marks an approval approved/denied/expired (pending/approved → terminal, one-way). */
  transitionApproval(id: number, to: 'approved' | 'denied' | 'expired' | 'consumed', now: number): boolean {
    const current = this.findApproval(id)
    if (current === undefined) return false
    if (to === 'approved' || to === 'denied' || to === 'expired') {
      if (current.status !== 'pending') return false
      const decided = to === 'approved' ? { decided: now, consumed: null } : { decided: now, consumed: null }
      const result = this.db
        .prepare('UPDATE worker_tool_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
        .run(to, decided.decided, id, 'pending')
      const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
      return changed !== 0
    }
    // consumed: only approved → consumed, exactly once.
    if (current.status !== 'approved') return false
    const result = this.db
      .prepare("UPDATE worker_tool_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
      .run(now, id)
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /** Applies lazy expiry to one approval (pending/approved older than limit → expired). */
  expireIfStale(id: number, now: number): boolean {
    const current = this.findApproval(id)
    if (current === undefined) return false
    if (current.status !== 'pending' && current.status !== 'approved') return false
    if (now - current.createdAt <= APPROVAL_MAX_AGE_MS) return false
    return this.transitionApproval(id, 'expired', now)
  }

  /** Persists one immutable tool event and returns its id. */
  appendEvent(input: {
    workspaceId: number
    sessionId: number
    runId: number
    toolName: string
    capability: string
    argsJson: string
    summary: string
    payload: string
    bytes: number
    status: string
    approvalId: number | null
    now: number
  }): number {
    const result = this.insertEventStmt.run(
      input.workspaceId, input.sessionId, input.runId, input.toolName, input.capability,
      input.argsJson, input.summary, input.payload, input.bytes, input.status, input.approvalId, input.now
    )
    return toRowId(result.lastInsertRowid, 'event')
  }

  /** All tool events for one run, insertion order. */
  listEvents(runId: number): StoredToolEvent[] {
    const rows: unknown = this.listEventsStmt.all(runId)
    if (!Array.isArray(rows)) throw new DatabaseError('stored tool event rows are invalid')
    return rows.map((row: unknown) => {
      if (!isRecord(row)) throw new DatabaseError('stored tool event row is invalid')
      const id = row['id']
      const run = row['orchestration_run_id']
      const workspaceId = row['workspace_id']
      const sessionId = row['session_id']
      const toolName = row['tool_name']
      const capability = row['capability']
      const argsJson = row['arguments_json']
      const summary = row['result_summary']
      const payload = row['result_payload']
      const bytes = row['result_bytes']
      const status = row['status']
      const createdAt = row['created_at']
      if (
        typeof id !== 'number' || typeof run !== 'number' || typeof workspaceId !== 'number' ||
        typeof sessionId !== 'number' || typeof toolName !== 'string' ||
        typeof capability !== 'string' || typeof argsJson !== 'string' || typeof summary !== 'string' ||
        typeof payload !== 'string' || typeof bytes !== 'number' || typeof status !== 'string' ||
        typeof createdAt !== 'number'
      ) {
        throw new DatabaseError('stored tool event row is invalid')
      }
      return {
        id, runId: run, workspaceId, sessionId, toolName, capability, argsJson, summary, payload, bytes, status,
        approvalId: asNullableNumber(row['approval_id']), createdAt
      }
    })
  }

  /** Upserts normalized run state (bounded, hashed). */
  saveState(input: {
    runId: number
    toolCallCount: number
    workerInstruction: string
    activeUserMessageId: number
    continuityUsed: boolean
    stateJson: string
    now: number
  }): void {
    if (encoder.encode(input.stateJson).byteLength > MAX_WORKER_TOOL_STATE_BYTES) {
      throw new DatabaseError('worker tool state is too large')
    }
    this.upsertStateStmt.run(
      input.runId, input.toolCallCount, input.workerInstruction, input.activeUserMessageId,
      input.continuityUsed ? 1 : 0, input.stateJson, hashState(input.stateJson), input.now
    )
  }

  /** Loads run state with hash verification, or undefined. */
  findState(runId: number): StoredRunState | undefined {
    const row: unknown = this.findStateStmt.get(runId)
    if (row === undefined) return undefined
    if (!isRecord(row)) throw new DatabaseError('stored run state row is invalid')
    const id = row['orchestration_run_id']
    const count = row['tool_call_count']
    const instruction = row['worker_instruction']
    const messageId = row['active_user_message_id']
    const used = row['continuity_used']
    const json = row['state_json']
    const hash = row['state_hash']
    const updatedAt = row['updated_at']
    if (
      typeof id !== 'number' || typeof count !== 'number' || typeof instruction !== 'string' ||
      typeof messageId !== 'number' || (used !== 0 && used !== 1) || typeof json !== 'string' ||
      typeof hash !== 'string' || typeof updatedAt !== 'number'
    ) {
      throw new DatabaseError('stored run state row is invalid')
    }
    if (hashState(json) !== hash) {
      throw new DatabaseError('worker tool state failed integrity verification')
    }
    return { runId: id, toolCallCount: count, workerInstruction: instruction, activeUserMessageId: messageId, continuityUsed: used === 1, stateJson: json, stateHash: hash, updatedAt }
  }
}
