import { TextEncoder } from 'node:util'
import { previewUrlForPort } from '../../shared/project-runtime/types'
import { MAX_RUNTIME_SESSION_MS } from '../project-runtime/project-runtime-limits'
import { MAX_WORKER_RUNTIME_OBSERVATION_BYTES } from '../worker-tools/worker-tool-limits'
import type { StoredRuntimeSession } from '../project-runtime/project-runtime-repository'

const encoder = new TextEncoder()

/** Minimal active-runtime source (repository or service adapter). */
export interface RuntimeObservationSource {
  findActiveForWorkspace(workspaceId: number): StoredRuntimeSession | undefined
  findById?(id: number): StoredRuntimeSession | undefined
}

/** Bounded normalized runtime observation returned to the Worker as DATA. */
export interface BoundedRuntimeObservation {
  readonly status: 'observed' | 'no_active_runtime'
  readonly payloadJson: string
  readonly summary: string
}

function parseStoredArgs(argsJson: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(argsJson) as unknown
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['args'])) {
      const args = (parsed as Record<string, unknown>)['args'] as unknown[]
      if (args.every((entry): entry is string => typeof entry === 'string')) {
        return [...args]
      }
    }
  } catch {
    // Stored rows are main-written; fall through to empty on surprise.
  }
  return []
}

function dropOldestChars(value: string, dropChars: number): string {
  if (dropChars <= 0 || value === '') {
    return value
  }
  const points = [...value]
  if (dropChars >= points.length) {
    return ''
  }
  return points.slice(dropChars).join('')
}

/**
 * Builds the bounded normalized observation payload for one stored
 * session. Prefers newest log text; drops oldest chars first and sets
 * olderOutputOmitted. Never mutates the canonical persisted tail.
 * Exposes no PID, paths, env, or credentials.
 */
export function buildRuntimeObservationPayload(
  row: StoredRuntimeSession,
  live?: { stdoutTail: string; stderrTail: string; logsTruncated: boolean; totalOutputBytes: number },
  maxBytes: number = MAX_WORKER_RUNTIME_OBSERVATION_BYTES
): { payloadJson: string; olderOutputOmitted: boolean } {
  const stdout = live?.stdoutTail ?? row.stdoutTail
  const stderr = live?.stderrTail ?? row.stderrTail
  const totalOutputBytes = live?.totalOutputBytes ?? row.totalOutputBytes
  const persistedTruncated = live?.logsTruncated ?? row.logsTruncated
  let currentStdout = stdout
  let currentStderr = stderr
  let olderOutputOmitted = persistedTruncated
  const base = (): string =>
    JSON.stringify({
      status: 'observed',
      runtime: {
        runtimeId: row.id,
        state: row.status,
        program: row.program,
        args: parseStoredArgs(row.argsJson),
        previewUrl: previewUrlForPort(row.previewPort),
        previewPort: row.previewPort,
        startedAt: row.startedAt,
        maximumLifetimeMs: MAX_RUNTIME_SESSION_MS
      },
      logs: {
        stdout: currentStdout,
        stderr: currentStderr,
        totalOutputBytes,
        olderOutputOmitted
      }
    })
  let payload = base()
  if (encoder.encode(payload).byteLength <= maxBytes) {
    return { payloadJson: payload, olderOutputOmitted }
  }
  olderOutputOmitted = true
  // Drop oldest log chars (larger tail first, bounded chunks so both
  // streams keep their newest text) until the serialized observation
  // fits the 64 KiB Worker budget.
  let guard = 0
  while (encoder.encode(payload).byteLength > maxBytes && (currentStdout !== '' || currentStderr !== '') && guard < 10000) {
    guard += 1
    const overflow = encoder.encode(payload).byteLength - maxBytes
    // Dropping N chars removes at least N bytes; drop in bounded
    // chunks to preserve newest text on both streams.
    const drop = Math.min(Math.max(Math.min(overflow, 4096), 512), Math.max(currentStdout.length, currentStderr.length))
    if (currentStdout.length >= currentStderr.length && currentStdout !== '') {
      currentStdout = dropOldestChars(currentStdout, drop)
    } else if (currentStderr !== '') {
      currentStderr = dropOldestChars(currentStderr, drop)
    } else {
      break
    }
    payload = JSON.stringify({
      status: 'observed',
      runtime: {
        runtimeId: row.id,
        state: row.status,
        program: row.program,
        args: parseStoredArgs(row.argsJson),
        previewUrl: previewUrlForPort(row.previewPort),
        previewPort: row.previewPort,
        startedAt: row.startedAt,
        maximumLifetimeMs: MAX_RUNTIME_SESSION_MS
      },
      logs: { stdout: currentStdout, stderr: currentStderr, totalOutputBytes, olderOutputOmitted }
    })
  }
  return { payloadJson: payload, olderOutputOmitted }
}

/**
 * Read-only runtime observation service (Stage 27, main only).
 * Resolves the single active (starting/running) managed runtime for
 * one workspace and returns a bounded normalized observation. Never
 * starts, stops, reloads, restarts, extends lifetime, or opens
 * Preview. Zero provider calls. No filesystem writes.
 */
export class RuntimeObservationService {
  constructor(private readonly deps: { readonly runtimes: RuntimeObservationSource }) {}

  /** Returns the active session row without side effects, or undefined. */
  getActiveForWorkspace(workspaceId: number): StoredRuntimeSession | undefined {
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return undefined
    }
    const active = this.deps.runtimes.findActiveForWorkspace(workspaceId)
    if (active === undefined) {
      return undefined
    }
    if (active.status !== 'starting' && active.status !== 'running') {
      return undefined
    }
    return active
  }

  /** Bounded observation for one workspace (no side effects). */
  observe(workspaceId: number): BoundedRuntimeObservation {
    const active = this.getActiveForWorkspace(workspaceId)
    if (active === undefined) {
      return {
        status: 'no_active_runtime',
        payloadJson: JSON.stringify({ status: 'no_active_runtime' }),
        summary: 'Observe managed runtime (no active runtime)'
      }
    }
    const { payloadJson } = buildRuntimeObservationPayload(active)
    return { status: 'observed', payloadJson, summary: `Observe managed runtime: ${active.program}` }
  }

  /**
   * Bounded observation for one exact bound runtime. Returns null
   * when the bound runtime is no longer the active starting/running
   * session (target changed) — no retargeting, no second approval.
   */
  observeBound(workspaceId: number, runtimeId: number): BoundedRuntimeObservation | null {
    const active = this.getActiveForWorkspace(workspaceId)
    if (active === undefined || active.id !== runtimeId) {
      return null
    }
    const { payloadJson } = buildRuntimeObservationPayload(active)
    return { status: 'observed', payloadJson, summary: `Observe managed runtime: ${active.program}` }
  }
}
