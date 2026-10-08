import { TextEncoder } from 'node:util'
import type { WorkerToolArguments, WorkerToolName, WorkerToolResult } from '../../shared/worker-tools/types'
import type { CapabilityGate } from '../capabilities/capability-gate'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import type { GitService } from '../git/git-service'
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
 * Bounded read-only tool executor (Stage 23). Validates the request,
 * consults CapabilityGate (worker only), then executes through the
 * existing bounded read/search/Git services. Writers, terminal,
 * transactions, and shells are never imported or called. Results are
 * untrusted DATA with strict byte caps and no truncation.
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
      const result: WorkerToolResult = {
        status: 'denied',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason: 'The workspace policy denies this action.'
      }
      this.persist(input, result)
      return result
    }
    if (decision.decision === 'requires_approval') {
      throw new InvalidWorkerToolRequestError('approval required')
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

  summaryFor(tool: WorkerToolName, args: WorkerToolArguments): string {
    if (tool === 'workspace_read') {
      return `Read ${(args as { relativePath: string }).relativePath}`
    }
    if (tool === 'workspace_search') {
      return `Search workspace for "${(args as { query: string }).query}"`
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
      // Read-only informational revision; grants no proposal authority.
      const payload = JSON.stringify({ relativePath: file.relativePath, content: file.content, revision: file.revision, bytes: file.size })
      return { status: 'succeeded', summary: `Read ${file.relativePath}`, payload }
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
}
