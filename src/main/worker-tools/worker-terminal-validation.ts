import { TextEncoder } from 'node:util'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'
import {
  MAX_WORKER_COMMAND_ARG_CODEPOINTS,
  MAX_WORKER_COMMAND_ARGS,
  MAX_WORKER_COMMAND_ARGUMENT_BYTES,
  MAX_WORKER_COMMAND_PROGRAM_CODEPOINTS
} from './worker-terminal-limits'

const encoder = new TextEncoder()

/** One validated terminal action: bare program plus inert argv data. */
export interface ValidatedTerminalCommand {
  readonly program: string
  readonly args: readonly string[]
}

function countCodePoints(value: string): number {
  return [...value].length
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
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

function validateProgram(program: unknown): string {
  if (typeof program !== 'string' || program === '') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (program.includes('\0') || program.includes('\n') || program.includes('\r')) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (hasUnpairedSurrogate(program)) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (countCodePoints(program) > MAX_WORKER_COMMAND_PROGRAM_CODEPOINTS) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  // Bare executable names only: no absolute/relative paths, no drive
  // specifiers, no directory traversal. The executable still resolves
  // through the sanitized PATH search at execution time.
  if (program.includes('/') || program.includes('\\') || program.includes(':')) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (program === '.' || program === '..') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return program
}

function validateArg(arg: unknown): string {
  if (typeof arg !== 'string') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (hasUnpairedSurrogate(arg)) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (countCodePoints(arg) > MAX_WORKER_COMMAND_ARG_CODEPOINTS) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return arg
}

/**
 * Strict main-owned validation for terminal_execute arguments. Exactly
 * `{program, args}` — no command string, cwd, env, shell, stdin,
 * timeout, background, or session fields. Shell metacharacters inside
 * argv stay inert data (argv execution, never a shell string).
 */
export function parseTerminalExecuteArgs(args: unknown): ValidatedTerminalCommand {
  if (!hasStrictShape(args, ['args', 'program'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const program = validateProgram(record['program'])
  const rawArgs = record['args']
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_WORKER_COMMAND_ARGS) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const validatedArgs = rawArgs.map(validateArg)
  let total = encoder.encode(program).byteLength
  for (const entry of validatedArgs) {
    total += encoder.encode(entry).byteLength
  }
  if (total > MAX_WORKER_COMMAND_ARGUMENT_BYTES) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return { program, args: validatedArgs }
}

/**
 * Exact human-readable approval summary for one validated command.
 * Program and argv stay structurally separate (indexed lines) so no
 * quoting ambiguity can hide the true action. Never exposes the host
 * absolute Workspace root — only the words "Workspace root".
 */
export function buildTerminalApprovalSummary(command: ValidatedTerminalCommand): string {
  const argLines =
    command.args.length === 0
      ? '(no arguments)'
      : command.args.map((entry, index) => `[${String(index)}] ${entry}`).join('\n')
  return (
    `Run command: ${command.program}\n` +
    `Program: ${command.program}\n` +
    `Arguments:\n${argLines}\n` +
    `Working directory: Workspace root`
  )
}

/**
 * Bounded inert-text rendering of one terminal outcome for run-step
 * display and tool-event summaries. Program, args, streams, and status
 * render as plain text only (never HTML, never ANSI interpretation).
 * No executable path, PID, or environment is included.
 */
export function buildTerminalStepSummary(
  program: string,
  args: readonly string[],
  result: {
    readonly status: 'completed' | 'spawn_failed' | 'timed_out' | 'output_limit'
    readonly exitCode: number | null
    readonly signal: string | null
    readonly stdout: string
    readonly stderr: string
    readonly truncated: boolean
    readonly durationMs: number
  }
): string {
  const statusLabel =
    result.status === 'completed'
      ? 'Completed'
      : result.status === 'spawn_failed'
        ? 'Spawn failed'
        : result.status === 'timed_out'
          ? 'Timed out'
          : 'Output limit reached'
  const argLines =
    args.length === 0 ? '(no arguments)' : args.map((entry, index) => `[${String(index)}] ${entry}`).join('\n')
  const lines = [
    `Run command: ${program}`,
    `Program: ${program}`,
    `Arguments:\n${argLines}`,
    `Status: ${statusLabel}`,
    `Exit code: ${result.exitCode === null ? 'n/a' : String(result.exitCode)}`,
    `Duration: ${String(result.durationMs)}ms`
  ]
  if (result.truncated) {
    lines.push('Output was truncated to the bounded capture limit.')
  }
  lines.push(`Stdout:\n${result.stdout === '' ? '(empty)' : result.stdout}`)
  lines.push(`Stderr:\n${result.stderr === '' ? '(empty)' : result.stderr}`)
  return lines.join('\n')
}

/** Canonical policy-deny copy for terminal.execute. */
export const WORKER_TERMINAL_DENY_MESSAGE = 'Terminal commands are not allowed for this Workspace.'

/** Canonical copy when persistent Allow is observed (never sufficient). */
export const WORKER_TERMINAL_INVALID_POLICY_MESSAGE =
  'Terminal commands require exact human approval and cannot run automatically.'

/** Canonical copy for human denial of a command approval. */
export const WORKER_TERMINAL_USER_DENY_MESSAGE = 'The user denied this command.'

/** Canonical copy for runs interrupted with a reserved but unexecuted command. */
export const WORKER_TERMINAL_INTERRUPTED_MESSAGE =
  'An approved Worker command was interrupted. Start the Work request again.'
