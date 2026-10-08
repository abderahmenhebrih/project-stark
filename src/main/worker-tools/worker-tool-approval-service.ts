import type { WorkerToolApproval } from '../../shared/worker-tools/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import { WorkerToolRepository } from './worker-tool-repository'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function toPublicApproval(stored: {
  readonly id: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly runId: number
  readonly toolName: string
  readonly capability: string
  readonly summary: string
  readonly status: string
  readonly createdAt: number
  readonly decidedAt: number | null
  readonly consumedAt: number | null
}): WorkerToolApproval {
  return {
    id: stored.id,
    workspaceId: stored.workspaceId,
    sessionId: stored.sessionId,
    runId: stored.runId,
    toolName: stored.toolName as WorkerToolApproval['toolName'],
    capability: stored.capability,
    summary: stored.summary,
    detail: stored.summary,
    status: stored.status as WorkerToolApproval['status'],
    createdAt: stored.createdAt,
    decidedAt: stored.decidedAt,
    consumedAt: stored.consumedAt
  }
}

/**
 * Approval service (Stage 23): creates exact per-action approvals,
 * validates ownership/hashes/single-use, applies lazy expiry. No tool
 * execution here — the resume coordinator executes through the tool
 * service after validation.
 */
export class WorkerToolApprovalService {
  private readonly now: () => number

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly runs: OrchestrationRepository,
    private readonly tools: WorkerToolRepository,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /** Newest pending approval for one workspace-owned session, or null. */
  getPending(raw: unknown): WorkerToolApproval | null {
    const { workspaceId, sessionId } = this.parseScope(raw)
    this.requireOwnership(workspaceId, sessionId)
    const pending = this.tools.findPendingForSession(sessionId)
    if (pending === undefined || pending.workspaceId !== workspaceId) {
      return null
    }
    if (this.tools.expireIfStale(pending.id, this.now())) {
      this.runs.updateRunState({
        id: pending.runId,
        status: 'failed',
        action: this.runs.findRunById(pending.runId)?.action ?? null,
        planSummary: this.runs.findRunById(pending.runId)?.planSummary ?? null,
        finalMessageId: this.runs.findRunById(pending.runId)?.finalMessageId ?? null,
        errorCategory: 'This Worker approval expired. Start the Work request again.',
        now: this.now()
      })
      return null
    }
    const fresh = this.tools.findApproval(pending.id)
    if (fresh === undefined) return null
    return toPublicApproval(fresh)
  }

  /** Validates and returns one approval for decide/resume paths. */
  loadForDecision(workspaceId: number, sessionId: number, approvalId: number): StoredApproval {
    if (!isValidId(workspaceId) || !isValidId(sessionId) || !isValidId(approvalId)) {
      throw new InvalidWorkerToolRequestError('approval reference is invalid')
    }
    this.requireOwnership(workspaceId, sessionId)
    const stored = this.tools.findApproval(approvalId)
    if (stored === undefined || stored.workspaceId !== workspaceId || stored.sessionId !== sessionId) {
      throw new InvalidWorkerToolRequestError('approval reference is invalid')
    }
    const run = this.runs.findRunById(stored.runId)
    if (run === undefined || run.workspaceId !== workspaceId || run.sessionId !== sessionId) {
      throw new InvalidWorkerToolRequestError('approval reference is invalid')
    }
    return stored as StoredApproval
  }

  private parseScope(raw: unknown): { workspaceId: number; sessionId: number } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new InvalidWorkerToolRequestError('approval request is invalid')
    }
    const record = raw as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidWorkerToolRequestError('approval request is invalid')
    }
    return { workspaceId, sessionId }
  }

  private requireOwnership(workspaceId: number, sessionId: number): void {
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new InvalidWorkerToolRequestError('workspace reference is invalid')
    }
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined || session.workspaceId !== workspaceId) {
      throw new InvalidWorkerToolRequestError('session reference is invalid')
    }
  }
}

type StoredApproval = {
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
