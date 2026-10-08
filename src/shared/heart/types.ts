/**
 * Shared Heart domain contract (Stage 19).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * Heart is STARK's deterministic model-routing layer: the Brain
 * requests a Worker task profile, Heart maps it to a user-configured
 * provider/model assignment. No credentials cross this boundary —
 * assignments carry provider and model IDs only.
 */

/** A provider/model assignment chosen by the user. No credentials. */
export interface HeartAssignment {
  readonly providerId: string
  readonly model: string
}

/** Worker routing mode. */
export type HeartWorkerMode = 'fixed' | 'auto_swap'

/** Bounded Worker task profiles the Brain may request. */
export type HeartWorkerProfile = 'general' | 'coding' | 'reasoning' | 'fast'

/** Public Heart configuration. Null routes mean unconfigured. */
export interface HeartConfig {
  readonly workerMode: HeartWorkerMode
  readonly brain: HeartAssignment
  readonly workerFixed: HeartAssignment | null
  readonly workerDefault: HeartAssignment | null
  readonly workerRoutes: {
    readonly general: HeartAssignment | null
    readonly coding: HeartAssignment | null
    readonly reasoning: HeartAssignment | null
    readonly fast: HeartAssignment | null
  }
}

/** Heart configuration update request. Complete configs only. */
export interface UpdateHeartConfigRequest {
  readonly workerMode: HeartWorkerMode
  readonly brain: HeartAssignment
  readonly workerFixed: HeartAssignment | null
  readonly workerDefault: HeartAssignment | null
  readonly workerRoutes: {
    readonly general: HeartAssignment | null
    readonly coding: HeartAssignment | null
    readonly reasoning: HeartAssignment | null
    readonly fast: HeartAssignment | null
  }
}

/** Heart slice of the preload bridge (`window.stark.heart`). */
export interface HeartApi {
  get: () => Promise<HeartConfig | null>
  update: (config: UpdateHeartConfigRequest) => Promise<HeartConfig>
}
