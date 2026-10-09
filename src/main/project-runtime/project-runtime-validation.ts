import { InvalidWorkerToolRequestError } from '../worker-tools/worker-tool-errors'
import { parseTerminalExecuteArgs } from '../worker-tools/worker-terminal-validation'
import { MAX_RUNTIME_PORT, MIN_RUNTIME_PORT } from './project-runtime-limits'
import { previewUrlForPort } from '../../shared/project-runtime/types'

/** One validated runtime_start action: bare program, inert argv, loopback port. */
export interface ValidatedRuntimeStart {
  readonly program: string
  readonly args: readonly string[]
  readonly port: number
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
 * Strict main-owned validation for runtime_start arguments. Exactly
 * `{program, args, port}` — program/argv reuse the Stage 25 terminal
 * rules verbatim (no command string, cwd, env, shell, stdin, timeout,
 * background, or session fields); port is an integer 1024–65535 with
 * no string coercion. The model never supplies a URL or host.
 */
export function parseRuntimeStartArgs(args: unknown): ValidatedRuntimeStart {
  if (!hasStrictShape(args, ['args', 'port', 'program'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const terminal = parseTerminalExecuteArgs({ program: record['program'], args: record['args'] })
  const port = record['port']
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_RUNTIME_PORT || port > MAX_RUNTIME_PORT) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return { program: terminal.program, args: terminal.args, port }
}

/**
 * Exact human-readable approval summary for one validated runtime
 * request. Program, argv, and the derived loopback preview stay
 * structurally separate; the host absolute Workspace root is never
 * exposed — only the words "Workspace root".
 */
export function buildRuntimeApprovalSummary(command: ValidatedRuntimeStart): string {
  const argLines =
    command.args.length === 0
      ? '(no arguments)'
      : command.args.map((entry, index) => `[${String(index)}] ${entry}`).join('\n')
  return (
    `Start project runtime: ${command.program}\n` +
    `Program: ${command.program}\n` +
    `Arguments:\n${argLines}\n` +
    `Preview: ${previewUrlForPort(command.port)}\n` +
    `Working directory: Workspace root`
  )
}

/** Canonical copy when another runtime already owns the workspace. */
export const WORKER_RUNTIME_ALREADY_ACTIVE_MESSAGE = 'A project runtime is already active for this workspace.'

/** Canonical policy-deny copy for runtime_start. */
export const WORKER_RUNTIME_DENY_MESSAGE = 'Project runtimes are not allowed for this Workspace.'

/** Canonical copy when persistent Allow is observed (never sufficient). */
export const WORKER_RUNTIME_INVALID_POLICY_MESSAGE =
  'Project runtimes require exact human approval and cannot start automatically.'

/** Canonical copy for human denial of a runtime approval. */
export const WORKER_RUNTIME_USER_DENY_MESSAGE = 'The user denied starting this runtime.'

/** Canonical copy for runs interrupted with a reserved but unstarted runtime. */
export const WORKER_RUNTIME_INTERRUPTED_MESSAGE =
  'This runtime was active when STARK stopped and will not be restarted automatically.'
