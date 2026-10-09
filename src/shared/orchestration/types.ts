/**
 * Shared orchestration-run domain contract (Stage 18).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A run records one bounded Brain → optional Worker → optional Brain
 * synthesis execution for a trailing user message. The final Brain
 * response is an ordinary assistant Session message; intermediate
 * artifacts live only in run steps. Group state is derived, never
 * a second source of truth.
 */

/** Lifecycle of an orchestration run. `interrupted` is crash recovery only. */
export type OrchestrationRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting_for_approval'

/** Brain plan decision for a run. */
export type OrchestrationRunAction = 'answer' | 'delegate'

/** Step kinds: Stage 18 base plus Stage 23 Worker follow-ups (one row per Worker turn). */
export type OrchestrationStepKind = 'brain_plan' | 'worker' | 'worker_followup' | 'brain_synthesis'

/** Step execution state. */
export type OrchestrationStepStatus = 'completed' | 'failed'

/** One persisted orchestration step. */
export interface OrchestrationStep {
  readonly id: number
  readonly runId: number
  readonly ordinal: number
  readonly kind: OrchestrationStepKind
  readonly status: OrchestrationStepStatus
  readonly instruction: string | null
  readonly output: string | null
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * Which provider/model/route actually performed this step, or null
   * for historical Stage 18 rows that predate model audit.
   */
  readonly modelAudit: StepModelAudit | null
}

/** Per-step model routing audit. Credentials never stored. */
export interface StepModelAudit {
  readonly role: 'brain' | 'worker'
  readonly providerId: string
  readonly model: string
  readonly routeKey: string
  readonly requestedProfile: string | null
}

/** Public orchestration run: header plus steps in ordinal order. */
export interface OrchestrationRun {
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
  readonly steps: readonly OrchestrationStep[]
  /**
   * Stage 28 Heart usage-routing explanation (empty for runs that
   * predate threshold routing — historical details omit it).
   */
  readonly usageRouteDecisions: readonly import('../usage/types').UsageRouteDecision[]
}

/** Reference to one persisted run. */
export interface OrchestrationRunRequest {
  readonly runId: number
}

/** Session-scoped recent-runs request. */
export interface ListOrchestrationRunsRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/** Orchestration slice of the preload bridge (`window.stark.orchestration`). */
export interface OrchestrationApi {
  get: (request: OrchestrationRunRequest) => Promise<OrchestrationRun>
  listRecent: (request: ListOrchestrationRunsRequest) => Promise<readonly OrchestrationRun[]>
}
