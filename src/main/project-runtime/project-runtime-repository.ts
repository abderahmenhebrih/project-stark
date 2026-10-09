import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ProjectRuntimeStatus, ProjectRuntimeStopReason } from '../../shared/project-runtime/types'
import { DatabaseError } from '../database/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored project runtime ${what} is invalid`)
  }
  return numeric
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') throw new DatabaseError('stored project runtime row is invalid')
  return value
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new DatabaseError('stored project runtime row is invalid')
  return value
}

/** Raw runtime session row. Never carries a PID, env, or absolute paths. */
export interface StoredRuntimeSession {
  readonly id: number
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly runId: number
  readonly approvalId: number
  readonly program: string
  readonly argsJson: string
  readonly argsHash: string
  readonly previewPort: number
  readonly status: ProjectRuntimeStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly logsTruncated: boolean
  readonly totalOutputBytes: number
  readonly stopReason: ProjectRuntimeStopReason | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly updatedAt: number
}

function mapSession(row: unknown): StoredRuntimeSession {
  if (!isRecord(row)) throw new DatabaseError('stored project runtime row is invalid')
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sourceSessionId = row['source_session_id']
  const runId = row['orchestration_run_id']
  const approvalId = row['approval_id']
  const program = row['program']
  const argsJson = row['arguments_json']
  const argsHash = row['arguments_hash']
  const previewPort = row['preview_port']
  const status = row['status']
  const stdoutTail = row['stdout_tail']
  const stderrTail = row['stderr_tail']
  const logsTruncated = row['logs_truncated']
  const totalOutputBytes = row['total_output_bytes']
  const createdAt = row['created_at']
  const updatedAt = row['updated_at']
  if (
    typeof id !== 'number' || typeof workspaceId !== 'number' || typeof sourceSessionId !== 'number' ||
    typeof runId !== 'number' || typeof approvalId !== 'number' || typeof program !== 'string' ||
    typeof argsJson !== 'string' || typeof argsHash !== 'string' || typeof previewPort !== 'number' ||
    typeof status !== 'string' || typeof stdoutTail !== 'string' || typeof stderrTail !== 'string' ||
    (logsTruncated !== 0 && logsTruncated !== 1) || typeof totalOutputBytes !== 'number' ||
    typeof createdAt !== 'number' || typeof updatedAt !== 'number'
  ) {
    throw new DatabaseError('stored project runtime row is invalid')
  }
  const stopReason = asNullableText(row['stop_reason'])
  return {
    id, workspaceId, sourceSessionId, runId, approvalId, program, argsJson, argsHash, previewPort,
    status: status as ProjectRuntimeStatus,
    exitCode: asNullableNumber(row['exit_code']),
    signal: asNullableText(row['signal']),
    stdoutTail, stderrTail, logsTruncated: logsTruncated === 1, totalOutputBytes,
    stopReason: stopReason as ProjectRuntimeStopReason | null,
    createdAt,
    startedAt: asNullableNumber(row['started_at']),
    endedAt: asNullableNumber(row['ended_at']),
    updatedAt
  }
}

const SELECT_COLUMNS =
  'id, workspace_id, source_session_id, orchestration_run_id, approval_id, program, arguments_json, ' +
  'arguments_hash, preview_port, status, exit_code, signal, stdout_tail, stderr_tail, logs_truncated, ' +
  'total_output_bytes, stop_reason, created_at, started_at, ended_at, updated_at'

/**
 * Typed repository over project_runtime_sessions (Stage 26).
 * Persistence only — no spawning, gating, or provider logic. The
 * reservation transaction also enforces one active runtime per
 * workspace and consumes the backing approval, so one approval can
 * never produce two runtimes and one workspace can never hold two
 * active ones.
 */
export class ProjectRuntimeRepository {
  private readonly db: DatabaseSync
  private readonly findByIdStmt: StatementSync
  private readonly findByApprovalStmt: StatementSync
  private readonly findActiveStmt: StatementSync
  private readonly listRecentStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.findByIdStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM project_runtime_sessions WHERE id = ?`)
    this.findByApprovalStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM project_runtime_sessions WHERE approval_id = ?`)
    this.findActiveStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM project_runtime_sessions ` +
        "WHERE workspace_id = ? AND (status = 'starting' OR status = 'running') ORDER BY id DESC LIMIT 1"
    )
    this.listRecentStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM project_runtime_sessions WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
  }

  /** Finds one session by id, or undefined. */
  findById(id: number): StoredRuntimeSession | undefined {
    const row: unknown = this.findByIdStmt.get(id)
    return row === undefined ? undefined : mapSession(row)
  }

  /** Finds the single session reserved for one approval, or undefined. */
  findByApproval(approvalId: number): StoredRuntimeSession | undefined {
    const row: unknown = this.findByApprovalStmt.get(approvalId)
    return row === undefined ? undefined : mapSession(row)
  }

  /** The active (starting/running) session for one workspace, or undefined. */
  findActiveForWorkspace(workspaceId: number): StoredRuntimeSession | undefined {
    const row: unknown = this.findActiveStmt.get(workspaceId)
    return row === undefined ? undefined : mapSession(row)
  }

  /** Newest-first sessions for one workspace, bounded by limit. */
  listRecentForWorkspace(workspaceId: number, limit: number): StoredRuntimeSession[] {
    const rows: unknown = this.listRecentStmt.all(workspaceId, limit)
    if (!Array.isArray(rows)) throw new DatabaseError('stored project runtime rows are invalid')
    return rows.map(mapSession)
  }

  /**
   * Atomically reserves at-most-once runtime start for one approved
   * action: verifies the approval is pending with the exact args hash
   * and scope, re-verifies no active workspace runtime, records the
   * human decision (approved), inserts the session row as `starting`,
   * and consumes the approval — all in ONE transaction. Throws
   * DatabaseError when the approval is missing, used, mismatched,
   * already reserved, or when another runtime is already active.
   */
  reserveStart(input: {
    approvalId: number
    workspaceId: number
    sessionId: number
    runId: number
    program: string
    argsJson: string
    argsHash: string
    previewPort: number
    now: number
  }): { runtimeId: number } {
    let runtimeId: number
    this.db.exec('BEGIN')
    try {
      const approval: unknown = this.db
        .prepare(
          'SELECT id, workspace_id, session_id, orchestration_run_id, arguments_hash, status ' +
            'FROM worker_tool_approvals WHERE id = ?'
        )
        .get(input.approvalId)
      if (!isRecord(approval)) {
        throw new DatabaseError('project runtime approval is missing')
      }
      if (
        approval['status'] !== 'pending' ||
        approval['workspace_id'] !== input.workspaceId ||
        approval['session_id'] !== input.sessionId ||
        approval['orchestration_run_id'] !== input.runId ||
        approval['arguments_hash'] !== input.argsHash
      ) {
        throw new DatabaseError('project runtime approval failed verification')
      }
      const active: unknown = this.db
        .prepare(
          'SELECT id FROM project_runtime_sessions ' +
            "WHERE workspace_id = ? AND (status = 'starting' OR status = 'running') LIMIT 1"
        )
        .get(input.workspaceId)
      if (active !== undefined) {
        throw new DatabaseError('a project runtime is already active for this workspace')
      }
      const approved = this.db
        .prepare('UPDATE worker_tool_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
        .run('approved', input.now, input.approvalId, 'pending')
      const approvedChanges = typeof approved.changes === 'bigint' ? Number(approved.changes) : approved.changes
      if (approvedChanges === 0) {
        throw new DatabaseError('project runtime approval is not pending')
      }
      const inserted = this.db
        .prepare(
          'INSERT INTO project_runtime_sessions (workspace_id, source_session_id, orchestration_run_id, approval_id, ' +
            'program, arguments_json, arguments_hash, preview_port, status, exit_code, signal, stdout_tail, stderr_tail, ' +
            'logs_truncated, total_output_bytes, stop_reason, created_at, started_at, ended_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          input.workspaceId, input.sessionId, input.runId, input.approvalId,
          input.program, input.argsJson, input.argsHash, input.previewPort, 'starting',
          null, null, '', '', 0, 0, null, input.now, null, null, input.now
        )
      runtimeId = toRowId(inserted.lastInsertRowid, 'runtime')
      const consumed = this.db
        .prepare("UPDATE worker_tool_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
        .run(input.now, input.approvalId)
      const consumedChanges = typeof consumed.changes === 'bigint' ? Number(consumed.changes) : consumed.changes
      if (consumedChanges === 0) {
        throw new DatabaseError('project runtime approval could not be consumed')
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
    return { runtimeId }
  }

  /** Marks a starting session running once the process has spawned. */
  markRunning(runtimeId: number, startedAt: number): boolean {
    const result = this.db
      .prepare('UPDATE project_runtime_sessions SET status = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('running', startedAt, startedAt, runtimeId, 'starting')
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /** Persists one coalesced bounded log-tail update for a live session. */
  updateLogTail(
    runtimeId: number,
    tail: { stdoutTail: string; stderrTail: string; logsTruncated: boolean; totalOutputBytes: number },
    now: number
  ): void {
    this.db
      .prepare(
        'UPDATE project_runtime_sessions SET stdout_tail = ?, stderr_tail = ?, logs_truncated = ?, ' +
          "total_output_bytes = ?, updated_at = ? WHERE id = ? AND (status = 'starting' OR status = 'running')"
      )
      .run(tail.stdoutTail, tail.stderrTail, tail.logsTruncated ? 1 : 0, tail.totalOutputBytes, now, runtimeId)
  }

  /**
   * Finalizes one live session exactly once. Later finalizations are
   * ignored (returns false) — terminal states never transition back.
   */
  finalizeSession(
    runtimeId: number,
    outcome: {
      status: 'stopped' | 'exited' | 'timed_out' | 'spawn_failed' | 'interrupted'
      exitCode: number | null
      signal: string | null
      stopReason: ProjectRuntimeStopReason
    },
    now: number
  ): boolean {
    const current = this.findById(runtimeId)
    if (current === undefined) return false
    if (current.status !== 'starting' && current.status !== 'running') return false
    const result = this.db
      .prepare(
        'UPDATE project_runtime_sessions SET status = ?, exit_code = ?, signal = ?, stop_reason = ?, ' +
          "ended_at = ?, updated_at = ? WHERE id = ? AND (status = 'starting' OR status = 'running')"
      )
      .run(outcome.status, outcome.exitCode, outcome.signal, outcome.stopReason, now, now, runtimeId)
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /**
   * One bounded startup pass: marks every leftover `starting`/`running`
   * session as `interrupted` and returns the affected run ids. Never
   * launches a process and never kills a PID from a previous instance
   * (PIDs are not persisted and may be reused by the OS).
   */
  markStartingAndRunningAsInterrupted(now: number): { interrupted: number; runIds: number[] } {
    const rows: unknown = this.db
      .prepare("SELECT DISTINCT orchestration_run_id AS runId FROM project_runtime_sessions WHERE status = 'starting' OR status = 'running'")
      .all()
    const runIds: number[] = []
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (isRecord(row) && typeof row['runId'] === 'number') {
          runIds.push(row['runId'])
        }
      }
    }
    const result = this.db
      .prepare("UPDATE project_runtime_sessions SET status = ?, stop_reason = ?, ended_at = ?, updated_at = ? WHERE status = 'starting' OR status = 'running'")
      .run('interrupted', 'interrupted', now, now)
    const changed = result.changes
    return { interrupted: typeof changed === 'bigint' ? Number(changed) : changed, runIds }
  }
}
