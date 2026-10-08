/**
 * Shared Recovery domain contract (Stage 21).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Continuity Recovery performs at most ONE automatic handoff when an
 * Ask or Work provider path fails with a recoverable category. No
 * fallback chains, no retries, no global model mutation.
 */

/** User-configured continuity recovery mode. */
export type RecoveryMode = 'off' | 'handoff' | 'auto_once'

/** Recovery role assignments. */
export type RecoveryRole = 'ask' | 'brain' | 'worker'

/** A provider/model assignment chosen by the user. No credentials. */
export interface RecoveryAssignment {
  readonly providerId: string
  readonly model: string
}

/** Public recovery configuration. Null routes mean unconfigured. */
export interface RecoveryConfig {
  readonly mode: RecoveryMode
  readonly ask: RecoveryAssignment | null
  readonly brain: RecoveryAssignment | null
  readonly worker: RecoveryAssignment | null
}

/** Recovery configuration update request. Complete configs only. */
export interface UpdateRecoveryConfigRequest {
  readonly mode: RecoveryMode
  readonly ask: RecoveryAssignment | null
  readonly brain: RecoveryAssignment | null
  readonly worker: RecoveryAssignment | null
}

/** Stable recoverable failure categories. */
export type RecoveryFailureCategory =
  | 'provider-rate-limit'
  | 'provider-network'
  | 'provider-timeout'
  | 'provider-unavailable'
  | 'model-unavailable'
  | 'structured-output-unsupported'

/** Recovery operation kind. Only Ask and Work recover. */
export type RecoveryOperation = 'ask' | 'work'

/** Lifecycle of a recovery event. Terminal states never transition automatically. */
export type RecoveryEventStatus =
  | 'handoff_ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dismissed'
  | 'interrupted'

/** Persisted recovery event (renderer-safe, no credentials). */
export interface RecoveryEvent {
  readonly id: number
  readonly workspaceId: number
  readonly sourceSessionId: number
  readonly targetSessionId: number
  readonly sourceMessageId: number
  readonly looplinkHandoffId: number
  readonly operation: RecoveryOperation
  readonly failureCategory: string
  readonly policyMode: string
  readonly status: RecoveryEventStatus
  readonly attemptCount: number
  readonly targetUserMessageId: number | null
  readonly targetAssistantMessageId: number | null
  readonly targetRunId: number | null
  readonly routes: readonly RecoveryEventRoute[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

/** One persisted recovery route (actual provider/model used). */
export interface RecoveryEventRoute {
  readonly role: RecoveryRole
  readonly providerId: string
  readonly model: string
}

/** Source-scoped recovery lookup request. */
export interface RecoveryForSourceRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly messageId: number
  readonly operation: RecoveryOperation
}

/** Target-scoped recovery lookup request. */
export interface RecoveryForTargetRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/** Recovery slice of the preload bridge (`window.stark.recovery`). */
export interface RecoveryApi {
  getConfig: () => Promise<RecoveryConfig | null>
  updateConfig: (config: UpdateRecoveryConfigRequest) => Promise<RecoveryConfig>
  getForSource: (request: RecoveryForSourceRequest) => Promise<RecoveryEvent | null>
  getForTarget: (request: RecoveryForTargetRequest) => Promise<RecoveryEvent | null>
  dismiss: (request: RecoveryForTargetRequest) => Promise<RecoveryEvent>
}
