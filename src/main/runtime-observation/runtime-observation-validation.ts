import { previewUrlForPort } from '../../shared/project-runtime/types'
import { InvalidWorkerToolRequestError } from '../worker-tools/worker-tool-errors'

/** One validated runtime_observe approved action: exact bound runtime only. */
export interface ValidatedRuntimeObserve {
  readonly runtimeId: number
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

/**
 * Strict main-owned validation for runtime_observe worker args.
 * Exactly `{}` — empty object, no runtimeId/workspaceId/sessionId/log
 * limit/offset/PID/path. Main derives the active runtime.
 */
export function parseRuntimeObserveArgs(args: unknown): Record<string, never> {
  if (!hasStrictShape(args, [])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return {}
}

/**
 * Strict validation for the canonical internal approved action
 * `{runtimeId}`. Provider/renderer never supply this shape — it is
 * main-derived at request time and hash-bound to the approval.
 */
export function parseRuntimeObserveApprovalArgs(args: unknown): ValidatedRuntimeObserve {
  if (!hasStrictShape(args, ['runtimeId'])) {
    throw new InvalidWorkerToolRequestError('approval arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const runtimeId = record['runtimeId']
  if (typeof runtimeId !== 'number' || !Number.isInteger(runtimeId) || runtimeId <= 0) {
    throw new InvalidWorkerToolRequestError('approval arguments are invalid')
  }
  return { runtimeId }
}

/** Canonical internal args JSON for one bound runtime observation. */
export function serializeRuntimeObserveApprovalArgs(runtimeId: number): { argsJson: string; summary: string } {
  void previewUrlForPort
  return { argsJson: JSON.stringify({ runtimeId }), summary: 'Observe managed runtime' }
}

/**
 * Exact human-readable approval summary for one bound runtime
 * observation. Program, argv, and the derived loopback preview stay
 * structurally separate and inert; no PID, paths, or environment.
 */
export function buildRuntimeObserveApprovalSummary(input: {
  program: string
  args: readonly string[]
  port: number
}): string {
  const argLines =
    input.args.length === 0
      ? '(no arguments)'
      : input.args.map((entry, index) => `[${String(index)}] ${entry}`).join('\n')
  return (
    `Observe managed runtime\n` +
    `Program: ${input.program}\n` +
    `Arguments:\n${argLines}\n` +
    `Preview: ${previewUrlForPort(input.port)}\n` +
    `This approval allows STARK Worker to read the current managed runtime state and bounded logs once.\n` +
    `This approval does not allow STARK Worker to stop, restart, or modify the runtime.`
  )
}

/** Canonical policy-deny copy for runtime.observe. */
export const WORKER_RUNTIME_OBSERVE_DENY_MESSAGE = 'Runtime observation is not allowed for this Workspace.'

/** Canonical copy for human denial of a runtime observation approval. */
export const WORKER_RUNTIME_OBSERVE_USER_DENY_MESSAGE = 'The user denied observing this runtime.'

/** Canonical copy when the bound runtime is no longer active. */
export const WORKER_RUNTIME_TARGET_CHANGED_MESSAGE = 'The approved runtime is no longer active. No observation was performed.'

/** Canonical copy when no managed runtime is active. */
export const WORKER_RUNTIME_NO_ACTIVE_MESSAGE = 'No active project runtime for this workspace.'
