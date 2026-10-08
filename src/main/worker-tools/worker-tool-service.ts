import { TextEncoder } from 'node:util'
import type { WorkerToolArguments, WorkerToolName, WorkerToolResult } from '../../shared/worker-tools/types'
import type { CapabilityGate } from '../capabilities/capability-gate'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import type { GitService } from '../git/git-service'
import type { ChangeSetService } from '../change-sets/change-set-service'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { WorkerCommandService } from './worker-command-service'
import type { WorkerToolRepository } from './worker-tool-repository'
import { capabilityForTool, isKnownWorkerTool } from './worker-tool-registry'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'
import {
  MAX_WORKER_GIT_RESULT_BYTES,
  MAX_WORKER_READ_BYTES,
  MAX_WORKER_SEARCH_QUERY_CODEPOINTS,
  MAX_WORKER_SEARCH_RESULTS,
  MAX_WORKER_SEARCH_RESULT_BYTES
} from './worker-tool-limits'
import { nextReadRef } from './worker-read-ref'
import {
  WORKER_PROPOSAL_DENY_MESSAGE,
  WORKER_PROPOSAL_STALE_MESSAGE,
  WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE,
  WORKER_PROPOSAL_USER_DENY_MESSAGE,
  parseChangeProposeArgs
} from './worker-proposal-validation'
import {
  WORKER_TERMINAL_DENY_MESSAGE,
  WORKER_TERMINAL_INVALID_POLICY_MESSAGE,
  WORKER_TERMINAL_USER_DENY_MESSAGE,
  buildTerminalStepSummary,
  parseTerminalExecuteArgs
} from './worker-terminal-validation'
import { hashToolArgs } from './worker-tool-repository'
import { createWorkerProposal, resolveProposalTargets } from './worker-proposal-service'

const encoder = new TextEncoder()

function countCodePoints(value: string): number {
  return [...value].length
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
 * Parses one normalized Worker tool request (single tool, exact args).
 * Rejects multiples/empties/mixed shapes — the provider-turn layer
 * guarantees at most one, this re-validates defensively.
 */
export function parseWorkerToolRequest(tool: string, args: unknown): WorkerToolArguments {
  if (!isKnownWorkerTool(tool)) {
    throw new InvalidWorkerToolRequestError('unknown tool')
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (tool === 'workspace_read') {
    if (!hasStrictShape(args, ['relativePath'])) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    const relativePath = (args as Record<string, unknown>)['relativePath']
    if (typeof relativePath !== 'string' || relativePath === '') {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    return { tool, relativePath }
  }
  if (tool === 'workspace_search') {
    if (!hasStrictShape(args, ['query'])) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    const query = (args as Record<string, unknown>)['query']
    if (typeof query !== 'string' || query === '') {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    if (countCodePoints(query) > MAX_WORKER_SEARCH_QUERY_CODEPOINTS) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    return { tool, query }
  }
  if (tool === 'change_propose') {
    // Strict shape + bounds (1–5 targets, unique refs, 64 KiB per file,
    // 192 KiB total, 300-cp summaries, no model-controlled paths).
    // Unknown/duplicate/stale refs are semantic failures handled at
    // execution time as bounded failed tool results.
    const parsed = parseChangeProposeArgs(args)
    return { tool, changes: [...parsed.changes] }
  }
  if (tool === 'terminal_execute') {
    // Strict program + argv only (bare executable name, inert args, no
    // command string/cwd/env/shell/stdin/timeout extras).
    const parsed = parseTerminalExecuteArgs(args)
    return { tool, program: parsed.program, args: [...parsed.args] }
  }
  if (!hasStrictShape(args, ['operation', 'scope', 'relativePath']) && !hasStrictShape(args, ['operation'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const operation = record['operation']
  if (operation === 'status') {
    if (!hasStrictShape(args, ['operation'])) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    return { tool: 'git_read', operation: 'status' }
  }
  if (operation === 'diff') {
    if (!hasStrictShape(args, ['operation', 'scope', 'relativePath'])) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    const scope = record['scope']
    const relativePath = record['relativePath']
    if (scope !== 'staged' && scope !== 'unstaged') {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    if (relativePath !== null && (typeof relativePath !== 'string' || relativePath === '')) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    return { tool: 'git_read', operation: 'diff', scope, relativePath }
  }
  throw new InvalidWorkerToolRequestError('tool arguments are invalid')
}

export interface ToolExecutionDeps {
  readonly gate: CapabilityGate
  readonly files: WorkspaceFilesService
  readonly search: WorkspaceSearchService
  readonly git: GitService
  readonly tools: WorkerToolRepository
  /** Stage 24 proposal creation only (pending transactions/sets, never writes). Optional for older harnesses. */
  readonly transactions?: ChangeTransactionService
  readonly changeSets?: ChangeSetService
  /** Stage 25 bounded command execution (reservation + spawn). Optional for older harnesses. */
  readonly commands?: WorkerCommandService
}

export interface ExecuteToolInput {
  readonly workspaceId: number
  readonly sessionId: number
  readonly runId: number
  readonly tool: WorkerToolName
  readonly args: WorkerToolArguments
  readonly argsJson: string
  readonly approvalId: number | null
  readonly now: number
}

/**
 * Bounded tool executor (Stage 24): read-only tools plus one
 * reviewable-proposal tool (change_propose). Validates the request,
 * consults CapabilityGate (worker only), then executes through the
 * existing bounded read/search/Git/proposal services. Direct writers,
 * terminal, shells, Accept/Reject/Rollback are never imported or
 * called — proposals persist as pending Stage 9 transactions or Stage
 * 17 Change Sets only. Results are untrusted DATA with strict caps.
 */
export class WorkerReadToolService {
  constructor(private readonly deps: ToolExecutionDeps) {}

  async execute(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const capability = capabilityForTool(input.tool)
    const decision = this.deps.gate.authorize({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: 'worker',
      capability
    })
    if (decision.decision === 'deny') {
      const deniedReason =
        input.tool === 'change_propose'
          ? WORKER_PROPOSAL_DENY_MESSAGE
          : input.tool === 'terminal_execute'
            ? WORKER_TERMINAL_DENY_MESSAGE
            : 'The workspace policy denies this action.'
      const result: WorkerToolResult = {
        status: 'denied',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason: deniedReason
      }
      this.persist(input, result)
      return result
    }
    if (decision.decision === 'requires_approval') {
      throw new InvalidWorkerToolRequestError('approval required')
    }
    if (input.tool === 'terminal_execute') {
      // Defense in depth: terminal persistent Allow is forbidden, so a
      // gate `allow` for terminal.execute is an invalid policy — never
      // sufficient for execution. No process spawns here, ever.
      const result: WorkerToolResult = {
        status: 'denied',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason: WORKER_TERMINAL_INVALID_POLICY_MESSAGE
      }
      this.persist(input, result)
      return result
    }
    try {
      const result = await this.executeAllowed(input)
      this.persist(input, result)
      return result
    } catch (error) {
      const result: WorkerToolResult = {
        status: 'failed',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason: error instanceof Error ? error.message : 'The tool could not complete.'
      }
      this.persist(input, result)
      return result
    }
  }

  /** Executes an already-approved exact action (hash validated by caller). */
  async executeApproved(input: ExecuteToolInput): Promise<WorkerToolResult> {
    if (input.tool === 'terminal_execute') {
      return await this.executeApprovedTerminal(input)
    }    try {
      const result = await this.executeAllowed(input)
      this.persist(input, result)
      return result
    } catch (error) {
      const result: WorkerToolResult = {
        status: 'failed',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason: error instanceof Error ? error.message : 'The tool could not complete.'
      }
      this.persist(input, result)
      return result
    }
  }

  /** Denied-user copy for change_propose approval denial (persisted by the runner). */
  static userDenyMessage(): string {
    return WORKER_PROPOSAL_USER_DENY_MESSAGE
  }

  /** Denied-user copy for terminal_execute approval denial (persisted by the runner). */
  static terminalUserDenyMessage(): string {
    return WORKER_TERMINAL_USER_DENY_MESSAGE
  }

  summaryFor(tool: WorkerToolName, args: WorkerToolArguments): string {
    if (tool === 'workspace_read') {
      return `Read ${(args as { relativePath: string }).relativePath}`
    }
    if (tool === 'workspace_search') {
      return `Search workspace for "${(args as { query: string }).query}"`
    }
    if (tool === 'change_propose') {
      const changes = (args as { changes?: readonly { summary?: unknown }[] }).changes
      const count = Array.isArray(changes) ? changes.length : 0
      if (count === 1) {
        return 'Create reviewable change proposal'
      }
      if (count > 1) {
        return `Create reviewable change proposal for ${String(count)} files`
      }
      return 'Create reviewable change proposal'
    }
    if (tool === 'terminal_execute') {
      return `Run command: ${(args as { program?: string }).program ?? ''}`
    }
    const record = args as Record<string, unknown>
    if (record['operation'] === 'status') return 'Read Git status'
    const scope = record['scope']
    const relativePath = record['relativePath']
    const base = scope === 'staged' ? 'Read staged Git diff' : 'Read unstaged Git diff'
    if (typeof relativePath === 'string' && relativePath !== '') {
      return `${base} for ${relativePath}`
    }
    return base
  }

  private persist(input: ExecuteToolInput, result: WorkerToolResult): void {
    const payload = result.payload
    const bytes = encoder.encode(payload).byteLength
    this.deps.tools.appendEvent({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      toolName: input.tool,
      capability: capabilityForTool(input.tool),
      argsJson: input.argsJson,
      summary: result.summary,
      payload,
      bytes,
      status: result.status,
      approvalId: input.approvalId,
      now: input.now
    })
  }

  private async executeAllowed(input: ExecuteToolInput): Promise<WorkerToolResult> {
    if (input.tool === 'workspace_read') {
      const { relativePath } = input.args as { relativePath: string }
      const file = await this.deps.files.readTextFile({ workspaceId: input.workspaceId, relativePath })
      const bytes = encoder.encode(file.content).byteLength
      if (bytes > MAX_WORKER_READ_BYTES) {
        return { status: 'failed', summary: `Read ${relativePath}`, payload: '', reason: 'File is too large for a Worker read.' }
      }
      // Deterministic same-run opaque ref (R1, R2, …) authorizing a later
      // change_propose. Denied/failed reads never allocate refs; mapping
      // reconstructs from persisted successful events after restart.
      const readRef = nextReadRef(
        this.deps.tools.listEvents(input.runId).map((event) => ({ toolName: event.toolName, status: event.status, payload: event.payload }))
      )
      const payload = JSON.stringify({ readRef, relativePath: file.relativePath, content: file.content, revision: file.revision, bytes: file.size })
      return { status: 'succeeded', summary: `Read ${file.relativePath}`, payload }
    }
    if (input.tool === 'change_propose') {
      return await this.executeProposal(input)
    }
    if (input.tool === 'workspace_search') {
      const { query } = input.args as { query: string }
      const found = await this.deps.search.search({ workspaceId: input.workspaceId, query, caseSensitive: false })
      const matches = found.matches.slice(0, MAX_WORKER_SEARCH_RESULTS)
      const limited: { relativePath: string; line: number; column: number; preview: string }[] = []
      let total = 2 // brackets
      let truncated = found.truncated
      for (const match of matches) {
        const entry = { relativePath: match.relativePath, line: match.line, column: match.column, preview: match.preview }
        const serialized = JSON.stringify(entry)
        if (limited.length >= MAX_WORKER_SEARCH_RESULTS || total + encoder.encode(serialized).byteLength > MAX_WORKER_SEARCH_RESULT_BYTES) {
          truncated = true
          break
        }
        limited.push(entry)
        total += encoder.encode(serialized).byteLength + 1
      }
      if (found.matches.length > matches.length) {
        truncated = true
      }
      const payload = JSON.stringify({ query, matches: limited, truncated })
      if (encoder.encode(payload).byteLength > MAX_WORKER_SEARCH_RESULT_BYTES + 1024) {
        return { status: 'failed', summary: `Search workspace for "${query}"`, payload: '', reason: 'Search results are too large.' }
      }
      return { status: 'succeeded', summary: `Search workspace for "${query}"`, payload }
    }
    const record = input.args as Record<string, unknown>
    if (record['operation'] === 'status') {
      const state = await this.deps.git.getStatus({ workspaceId: input.workspaceId })
      const payload = JSON.stringify(state)
      if (encoder.encode(payload).byteLength > MAX_WORKER_GIT_RESULT_BYTES) {
        return { status: 'failed', summary: 'Read Git status', payload: '', reason: 'Git status is too large.' }
      }
      return { status: 'succeeded', summary: 'Read Git status', payload }
    }
    const scope = record['scope'] as 'staged' | 'unstaged'
    const relativePath = record['relativePath'] as string | null
    // Untracked-file and membership authority stays inside the Git service.
    const diff = relativePath === null
      ? await this.deps.git.getDiff({ workspaceId: input.workspaceId, relativePath: '', target: scope })
        .catch(() => this.deps.git.getStatus({ workspaceId: input.workspaceId }))
      : await this.deps.git.getDiff({ workspaceId: input.workspaceId, relativePath, target: scope })
    const payload = JSON.stringify(diff)
    if (encoder.encode(payload).byteLength > MAX_WORKER_GIT_RESULT_BYTES) {
      return { status: 'failed', summary: this.summaryFor(input.tool, input.args), payload: '', reason: 'Git diff is too large.' }
    }
    return { status: 'succeeded', summary: this.summaryFor(input.tool, input.args), payload }
  }

  /**
   * Executes one validated change_propose through the EXISTING Stage 9 /
   * Stage 17 services only. Resolves opaque same-run readRefs to exact
   * path/revision/content, drops no-ops, creates exactly one pending
   * transaction (single) or one Change Set (multi). Disk unchanged.
   * Zero provider calls. Stale/unknown refs fail bounded with no
   * persistence of partial proposals.
   */
  private async executeProposal(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const transactions = this.deps.transactions
    const changeSets = this.deps.changeSets
    if (transactions === undefined || changeSets === undefined) {
      return { status: 'failed', summary: 'Create reviewable change proposal', payload: '', reason: 'Code proposals are unavailable.' }
    }
    const raw = input.args as unknown as { changes?: unknown }
    let changes: readonly { targetRef: string; summary: string; proposedContent: string }[]
    try {
      const parsed = parseChangeProposeArgs({ changes: raw.changes })
      changes = parsed.changes
    } catch {
      return { status: 'failed', summary: 'Create reviewable change proposal', payload: '', reason: 'Proposal arguments are invalid.' }
    }
    const resolved = resolveProposalTargets({
      tools: this.deps.tools,
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      changes
    })
    if (!resolved.ok) {
      return { status: 'failed', summary: 'Create reviewable change proposal', payload: '', reason: WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE }
    }
    let outcome: Awaited<ReturnType<typeof createWorkerProposal>>
    try {
      outcome = await createWorkerProposal({ transactions, changeSets, workspaceId: input.workspaceId, resolved: resolved.resolved })
    } catch (error) {
      return {
        status: 'failed',
        summary: 'Create reviewable change proposal',
        payload: '',
        reason: error instanceof Error ? error.message : 'The tool could not complete.'
      }
    }
    if (outcome.kind === 'stale') {
      return { status: 'failed', summary: 'Create reviewable change proposal', payload: '', reason: WORKER_PROPOSAL_STALE_MESSAGE }
    }
    if (outcome.kind === 'no_changes') {
      const payload = JSON.stringify({ status: 'no_changes' })
      return { status: 'succeeded', summary: 'Create reviewable change proposal (no changes)', payload }
    }
    if (outcome.kind === 'single') {
      const path = outcome.files[0]?.relativePath ?? 'file'
      const payload = JSON.stringify({ status: 'proposal_created', kind: 'single', transactionId: outcome.transactionId, files: outcome.files })
      return { status: 'succeeded', summary: `Create reviewable change proposal for ${path}`, payload }
    }
    const payload = JSON.stringify({ status: 'proposal_created', kind: 'change_set', changeSetId: outcome.changeSetId, files: outcome.files })
    return { status: 'succeeded', summary: `Create reviewable change proposal for ${String(outcome.files.length)} files`, payload }
  }

  /**
   * Executes one human-approved terminal action at most once. The caller
   * must have verified the approval is pending with the exact args hash;
   * this re-parses the exact persisted args, re-runs the gate (only
   * `requires_approval` proceeds — `allow` fails closed), reserves the
   * execution + consumes the approval in ONE transaction BEFORE spawning,
   * then spawns exactly once and persists the bounded audit event.
   * Integrity/database failures persist a failed event and throw nothing
   * spawnable — the run fails safely upstream.
   */
  private async executeApprovedTerminal(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const fallbackSummary = this.summaryFor(input.tool, input.args)
    const commands = this.deps.commands
    if (commands === undefined) {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Terminal commands are unavailable.'
      }
      this.persist(input, result)
      return result
    }
    let program: string
    let args: readonly string[]
    try {
      const canonical: unknown = JSON.parse(input.argsJson) as unknown
      const validated = parseTerminalExecuteArgs(canonical)
      program = validated.program
      args = validated.args
    } catch {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Terminal command arguments are invalid.'
      }
      this.persist(input, result)
      return result
    }
    if (input.approvalId === null) {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Terminal commands require exact human approval.'
      }
      this.persist(input, result)
      return result
    }
    let outcome: Awaited<ReturnType<WorkerCommandService['executeApprovedTerminal']>>
    try {
      outcome = await commands.executeApprovedTerminal({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        runId: input.runId,
        approvalId: input.approvalId,
        argsJson: input.argsJson,
        argsHash: hashToolArgs(input.argsJson),
        now: input.now
      })
    } catch (error) {
      const result: WorkerToolResult = {
        status: 'failed',
        summary: fallbackSummary,
        payload: '',
        reason: error instanceof Error ? error.message : 'The tool could not complete.'
      }
      this.persist(input, result)
      return result
    }
    if (outcome.kind === 'denied') {
      const result: WorkerToolResult = { status: 'denied', summary: fallbackSummary, payload: '', reason: outcome.reason }
      this.persist(input, result)
      return result
    }
    const result = outcome.result
    const payload = JSON.stringify({
      status: result.status,
      program,
      args: [...args],
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      outputBytes: result.outputBytes,
      truncated: result.truncated,
      durationMs: result.durationMs
    })
    // Executed outcomes (even spawn failures, timeouts, output caps, or
    // nonzero exits) are bounded results the Worker may reason about and
    // continue within budget — never automatic retries.
    const summary = buildTerminalStepSummary(program, args, result)
    const toolResult: WorkerToolResult = { status: 'succeeded', summary, payload }
    this.persist({ ...input, argsJson: input.argsJson }, toolResult)
    return toolResult
  }
}
