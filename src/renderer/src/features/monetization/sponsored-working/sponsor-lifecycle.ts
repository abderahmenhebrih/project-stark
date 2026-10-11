/**
 * STARK sponsored-working AI run lifecycle seam.
 *
 * CONTRACT FOR THE UPCOMING BRAIN/HEART MODEL RUNTIME (see §36):
 *
 * The runtime only needs to emit the equivalent of:
 *
 *   runStarted(runId)
 *   runStateChanged(runId, state)
 *   runCompleted(runId)
 *   runFailed(runId)
 *   runCancelled(runId)
 *
 * and later:
 *
 *   recordInferenceCost(runId, modelId, costMicros)
 *
 * The AI runtime MUST NOT import sponsor UI/components. Monetization
 * observes lifecycle events through the narrow store below.
 *
 * CURRENT SOURCE TRUTH (no runtime rewrite to manufacture states):
 * - Ask generation in flight (session `generating`)         → 'thinking'
 * - Session send in flight (session `sending`)               → 'queued'
 * - Brain work flight (work `preparing`)                     → 'working'
 * - Proposal flight (proposal `preparing`)                   → 'working'
 * - Looplink continuation flight (looplink `acting`)         → 'tool-running'
 * - Nothing in flight                                        → 'idle'
 * - Terminal outcomes map 1:1                               → completed/failed/cancelled
 *
 * 'streaming' and 'waiting-provider' are reserved for the upcoming
 * runtime; the current single-invoke flights cannot report them, so this
 * adapter never fabricates them. Streaming is deliberately NOT sponsor
 * eligible: when the answer is already streaming, user attention belongs
 * to the response.
 *
 * One run may later contain a Brain LoopLink then a Heart LoopLink. The
 * sponsor belongs to the overall USER RUN (one run → at most one counted
 * impression), never to individual model calls.
 */

import type { AiRunId, AiRunState } from './sponsor-types'

/** States in which a sponsor surface may become eligible (genuine work). */
const GENUINELY_WORKING: ReadonlySet<AiRunState> = new Set<AiRunState>([
  'thinking',
  'working',
  'tool-running',
  'waiting-provider'
])

/** Terminal states: the sponsor surface must disappear immediately. */
const TERMINAL_STATES: ReadonlySet<AiRunState> = new Set<AiRunState>([
  'completed',
  'failed',
  'cancelled'
])

/** True while STARK is genuinely working (sponsor-eligible states only). */
export function isGenuinelyWorking(state: AiRunState): boolean {
  return GENUINELY_WORKING.has(state)
}

/** True for completed / failed / cancelled (sponsor must hide at once). */
export function isTerminalRunState(state: AiRunState): boolean {
  return TERMINAL_STATES.has(state)
}

/**
 * Existing SessionPanel flight flags folded into one observable state.
 * Priority mirrors user-visible progress: Brain work > Looplink tool leg >
 * proposal work > Ask thinking > queued send > idle. Queued is used only
 * when a send is in flight without any richer working signal yet.
 */
export interface SessionFlightFlags {
  readonly sending: boolean
  readonly generating: boolean
  readonly proposalPreparing: boolean
  readonly workPreparing: boolean
  readonly looplinkActing: boolean
}

export function deriveAiRunState(flags: SessionFlightFlags): AiRunState {
  if (flags.workPreparing) {
    return 'working'
  }
  if (flags.looplinkActing) {
    return 'tool-running'
  }
  if (flags.proposalPreparing) {
    return 'working'
  }
  if (flags.generating) {
    return 'thinking'
  }
  if (flags.sending) {
    return 'queued'
  }
  return 'idle'
}

/**
 * Builds an opaque run id for the current flight. The id is the future
 * cost-attribution correlation key (Brain calls + Heart calls → one run).
 * No prompt, session text, or workspace data is encoded in the id.
 */
export function buildAiRunId(parts: {
  readonly workspaceId: number
  readonly sessionId: number | null
  readonly generationRequestId: number
}): AiRunId {
  const session = parts.sessionId === null ? 'none' : String(parts.sessionId)
  return `run-${String(parts.workspaceId)}-${session}-${String(parts.generationRequestId)}`
}

export type AiRunLifecycleEvent =
  | { readonly type: 'run-started'; readonly runId: AiRunId }
  | { readonly type: 'run-state-changed'; readonly runId: AiRunId; readonly state: AiRunState }
  | { readonly type: 'run-completed'; readonly runId: AiRunId }
  | { readonly type: 'run-failed'; readonly runId: AiRunId }
  | { readonly type: 'run-cancelled'; readonly runId: AiRunId }

export type AiRunLifecycleListener = (event: AiRunLifecycleEvent) => void

/**
 * Minimal observable run store for the upcoming Brain/Heart runtime.
 * Event-driven only: no polling, no timers, no retries. Listeners are
 * the sponsor slot (and later cost attribution); the runtime never
 * imports sponsor UI.
 */
export interface AiRunLifecycleStore {
  getState(runId: AiRunId): AiRunState
  runStarted(runId: AiRunId): void
  runStateChanged(runId: AiRunId, state: AiRunState): void
  runCompleted(runId: AiRunId): void
  runFailed(runId: AiRunId): void
  runCancelled(runId: AiRunId): void
  subscribe(listener: AiRunLifecycleListener): () => void
  /**
   * Future cost-attribution seam: Brain / Heart / other hosted calls
   * attribute actual cost to the run id. In-memory only; no billing math.
   */
  recordInferenceCost(runId: AiRunId, modelId: string, costMicros: number): void
  getInferenceCostMicros(runId: AiRunId): number | null
}

interface CostEntry {
  readonly modelId: string
  readonly costMicros: number
}

export function createAiRunLifecycleStore(): AiRunLifecycleStore {
  const states = new Map<AiRunId, AiRunState>()
  const costs = new Map<AiRunId, CostEntry[]>()
  const listeners = new Set<AiRunLifecycleListener>()

  function emit(event: AiRunLifecycleEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Observer failures must never break the AI run.
      }
    }
  }

  function setState(runId: AiRunId, state: AiRunState, event: AiRunLifecycleEvent): void {
    states.set(runId, state)
    emit(event)
  }

  return {
    getState(runId: AiRunId): AiRunState {
      return states.get(runId) ?? 'idle'
    },
    runStarted(runId: AiRunId): void {
      setState(runId, 'queued', { type: 'run-started', runId })
    },
    runStateChanged(runId: AiRunId, state: AiRunState): void {
      setState(runId, state, { type: 'run-state-changed', runId, state })
    },
    runCompleted(runId: AiRunId): void {
      setState(runId, 'completed', { type: 'run-completed', runId })
    },
    runFailed(runId: AiRunId): void {
      setState(runId, 'failed', { type: 'run-failed', runId })
    },
    runCancelled(runId: AiRunId): void {
      setState(runId, 'cancelled', { type: 'run-cancelled', runId })
    },
    subscribe(listener: AiRunLifecycleListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    recordInferenceCost(runId: AiRunId, modelId: string, costMicros: number): void {
      if (!Number.isFinite(costMicros) || costMicros < 0) {
        return
      }
      const entries = costs.get(runId) ?? []
      entries.push({ modelId, costMicros })
      costs.set(runId, entries)
    },
    getInferenceCostMicros(runId: AiRunId): number | null {
      const entries = costs.get(runId)
      if (entries === undefined || entries.length === 0) {
        return null
      }
      let total = 0
      for (const entry of entries) {
        total += entry.costMicros
      }
      return total
    }
  }
}
