import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DatabaseError } from '../database/errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toRowId(value: unknown, what: string): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) {
    throw new DatabaseError(`stored worker command ${what} is invalid`)
  }
  return numeric
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') throw new DatabaseError('stored worker command row is invalid')
  return value
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new DatabaseError('stored worker command row is invalid')
  return value
}

/** Service-valid execution statuses. No SQLite CHECK lock. */
export type WorkerCommandStatus =
  | 'launching'
  | 'running'
  | 'completed'
  | 'spawn_failed'
  | 'timed_out'
  | 'output_limit'
  | 'interrupted'

/** Raw command execution row. Never carries a PID, env, or absolute executable path. */
export interface StoredCommandExecution {
  readonly id: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly runId: number
  readonly approvalId: number
  readonly program: string
  readonly argsJson: string
  readonly argsHash: string
  readonly status: WorkerCommandStatus
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly outputBytes: number
  readonly truncated: boolean
  readonly durationMs: number | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly completedAt: number | null
}

function mapExecution(row: unknown): StoredCommandExecution {
  if (!isRecord(row)) throw new DatabaseError('stored worker command row is invalid')
  const id = row['id']
  const workspaceId = row['workspace_id']
  const sessionId = row['session_id']
  const runId = row['orchestration_run_id']
  const approvalId = row['approval_id']
  const program = row['program']
  const argsJson = row['arguments_json']
  const argsHash = row['arguments_hash']
  const status = row['status']
  const stdout = row['stdout']
  const stderr = row['stderr']
  const outputBytes = row['output_bytes']
  const truncated = row['truncated']
  const createdAt = row['created_at']
  if (
    typeof id !== 'number' || typeof workspaceId !== 'number' || typeof sessionId !== 'number' ||
    typeof runId !== 'number' || typeof approvalId !== 'number' || typeof program !== 'string' ||
    typeof argsJson !== 'string' || typeof argsHash !== 'string' || typeof status !== 'string' ||
    typeof stdout !== 'string' || typeof stderr !== 'string' || typeof outputBytes !== 'number' ||
    (truncated !== 0 && truncated !== 1) || typeof createdAt !== 'number'
  ) {
    throw new DatabaseError('stored worker command row is invalid')
  }
  return {
    id, workspaceId, sessionId, runId, approvalId, program, argsJson, argsHash,
    status: status as WorkerCommandStatus,
    exitCode: asNullableNumber(row['exit_code']),
    signal: asNullableText(row['signal']),
    stdout, stderr, outputBytes, truncated: truncated === 1,
    durationMs: asNullableNumber(row['duration_ms']),
    createdAt,
    startedAt: asNullableNumber(row['started_at']),
    completedAt: asNullableNumber(row['completed_at'])
  }
}

/**
 * Typed repository over worker_command_executions (Stage 25).
 * Persistence only — no spawning, gating, or provider logic. The
 * reservation transaction also consumes the backing approval, so one
 * approval can never produce two executions.
 */
export class WorkerCommandRepository {
  private readonly db: DatabaseSync
  private readonly findByIdStmt: StatementSync
  private readonly findByApprovalStmt: StatementSync
  private readonly listForRunStmt: StatementSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.findByIdStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, ' +
        'arguments_hash, status, exit_code, signal, stdout, stderr, output_bytes, truncated, duration_ms, ' +
        'created_at, started_at, completed_at FROM worker_command_executions WHERE id = ?'
    )
    this.findByApprovalStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, ' +
        'arguments_hash, status, exit_code, signal, stdout, stderr, output_bytes, truncated, duration_ms, ' +
        'created_at, started_at, completed_at FROM worker_command_executions WHERE approval_id = ?'
    )
    this.listForRunStmt = db.prepare(
      'SELECT id, workspace_id, session_id, orchestration_run_id, approval_id, program, arguments_json, ' +
        'arguments_hash, status, exit_code, signal, stdout, stderr, output_bytes, truncated, duration_ms, ' +
        'created_at, started_at, completed_at FROM worker_command_executions WHERE orchestration_run_id = ? ORDER BY id ASC'
    )
  }

  /** Finds one execution by id, or undefined. */
  findById(id: number): StoredCommandExecution | undefined {
    const row: unknown = this.findByIdStmt.get(id)
    return row === undefined ? undefined : mapExecution(row)
  }

  /** Finds the single execution reserved for one approval, or undefined. */
  findByApproval(approvalId: number): StoredCommandExecution | undefined {
    const row: unknown = this.findByApprovalStmt.get(approvalId)
    return row === undefined ? undefined : mapExecution(row)
  }

  /** All executions for one run, insertion order. */
  listForRun(runId: number): StoredCommandExecution[] {
    const rows: unknown = this.listForRunStmt.all(runId)
    if (!Array.isArray(rows)) throw new DatabaseError('stored worker command rows are invalid')
    return rows.map(mapExecution)
  }

  /**
   * Atomically reserves at-most-once execution for one approved action:
   * verifies the approval is pending with the exact args hash and scope,
   * records the human decision (approved), inserts the execution row as
   * `launching`, and consumes the approval — all in ONE transaction.
   * Either everything lands or nothing does. Throws DatabaseError when
   * the approval is missing, already used, mismatched, or already
   * reserved (UNIQUE approval_id).
   */
  reserveExecution(input: {
    approvalId: number
    workspaceId: number
    sessionId: number
    runId: number
    program: string
    argsJson: string
    argsHash: string
    now: number
  }): { executionId: number } {
    let executionId: number
    this.db.exec('BEGIN')
    try {
      const approval: unknown = this.db
        .prepare(
          'SELECT id, workspace_id, session_id, orchestration_run_id, arguments_hash, status ' +
            'FROM worker_tool_approvals WHERE id = ?'
        )
        .get(input.approvalId)
      if (!isRecord(approval)) {
        throw new DatabaseError('worker command approval is missing')
      }
      if (
        approval['status'] !== 'pending' ||
        approval['workspace_id'] !== input.workspaceId ||
        approval['session_id'] !== input.sessionId ||
        approval['orchestration_run_id'] !== input.runId ||
        approval['arguments_hash'] !== input.argsHash
      ) {
        throw new DatabaseError('worker command approval failed verification')
      }
      const approved = this.db
        .prepare('UPDATE worker_tool_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
        .run('approved', input.now, input.approvalId, 'pending')
      const approvedChanges = typeof approved.changes === 'bigint' ? Number(approved.changes) : approved.changes
      if (approvedChanges === 0) {
        throw new DatabaseError('worker command approval is not pending')
      }
      const inserted = this.db
        .prepare(
          'INSERT INTO worker_command_executions (workspace_id, session_id, orchestration_run_id, approval_id, ' +
            'program, arguments_json, arguments_hash, status, exit_code, signal, stdout, stderr, output_bytes, ' +
            'truncated, duration_ms, created_at, started_at, completed_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          input.workspaceId, input.sessionId, input.runId, input.approvalId,
          input.program, input.argsJson, input.argsHash, 'launching',
          null, null, '', '', 0, 0, null, input.now, null, null
        )
      executionId = toRowId(inserted.lastInsertRowid, 'execution')
      const consumed = this.db
        .prepare("UPDATE worker_tool_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
        .run(input.now, input.approvalId)
      const consumedChanges = typeof consumed.changes === 'bigint' ? Number(consumed.changes) : consumed.changes
      if (consumedChanges === 0) {
        throw new DatabaseError('worker command approval could not be consumed')
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
    return { executionId }
  }

  /** Marks a launching execution running once the process has spawned. */
  markRunning(executionId: number, startedAt: number): boolean {
    const result = this.db
      .prepare('UPDATE worker_command_executions SET status = ?, started_at = ? WHERE id = ? AND status = ?')
      .run('running', startedAt, executionId, 'launching')
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /**
   * Finalizes one launching/running execution exactly once. Later
   * finalizations are ignored (returns false) — no second spawn, no
   * overwrite of the recorded outcome.
   */
  finalizeExecution(
    executionId: number,
    outcome: {
      status: 'completed' | 'spawn_failed' | 'timed_out' | 'output_limit'
      exitCode: number | null
      signal: string | null
      stdout: string
      stderr: string
      outputBytes: number
      truncated: boolean
      durationMs: number | null
    },
    completedAt: number
  ): boolean {
    const current = this.findById(executionId)
    if (current === undefined) return false
    if (current.status !== 'launching' && current.status !== 'running') return false
    const result = this.db
      .prepare(
        'UPDATE worker_command_executions SET status = ?, exit_code = ?, signal = ?, stdout = ?, stderr = ?, ' +
          'output_bytes = ?, truncated = ?, duration_ms = ?, completed_at = ? ' +
          "WHERE id = ? AND (status = 'launching' OR status = 'running')"
      )
      .run(
        outcome.status, outcome.exitCode, outcome.signal, outcome.stdout, outcome.stderr,
        outcome.outputBytes, outcome.truncated ? 1 : 0, outcome.durationMs, completedAt, executionId
      )
    const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes
    return changed !== 0
  }

  /**
   * One bounded startup pass: marks every leftover `launching`/`running`
   * execution as `interrupted` and returns the affected run ids. Never
   * launches a process, never kills a PID from a previous instance (PIDs
   * are not persisted and may be reused by the OS).
   */
  markLaunchingAndRunningAsInterrupted(now: number): { interrupted: number; runIds: number[] } {
    const rows: unknown = this.db
      .prepare("SELECT DISTINCT orchestration_run_id AS runId FROM worker_command_executions WHERE status = 'launching' OR status = 'running'")
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
      .prepare("UPDATE worker_command_executions SET status = ?, completed_at = ? WHERE status = 'launching' OR status = 'running'")
      .run('interrupted', now)
    const changed = result.changes
    return { interrupted: typeof changed === 'bigint' ? Number(changed) : changed, runIds }
  }
}
