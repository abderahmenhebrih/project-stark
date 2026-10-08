import type { AgentCapability } from '../../shared/capabilities/types'
import type { WorkerToolName } from '../../shared/worker-tools/types'

/**
 * Static Worker tool registry (Stage 23): exactly three read-only
 * tools mapped to Stage 22 capabilities. Main-owned — never from
 * renderer, provider, or Brain/Worker output.
 */

export const WORKER_TOOLS: readonly WorkerToolName[] = ['workspace_read', 'workspace_search', 'git_read']

const TOOL_TO_CAPABILITY: Readonly<Record<WorkerToolName, AgentCapability>> = {
  workspace_read: 'workspace.read',
  workspace_search: 'workspace.search',
  git_read: 'git.read'
}

const KNOWN: ReadonlySet<string> = new Set<string>(WORKER_TOOLS)

/** True for exactly the three known tools. */
export function isKnownWorkerTool(value: string): value is WorkerToolName {
  return KNOWN.has(value)
}

/** Stage 22 capability backing one tool. */
export function capabilityForTool(tool: WorkerToolName): AgentCapability {
  return TOOL_TO_CAPABILITY[tool]
}

/** Main-owned JSON schemas advertised to the Worker (never renderer). */
export function workerToolSchemas(): { readonly name: WorkerToolName; readonly description: string; readonly parameters: unknown }[] {
  return [
    {
      name: 'workspace_read',
      description: 'Read one workspace text file (bounded, read-only).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['relativePath'],
        properties: { relativePath: { type: 'string' } }
      }
    },
    {
      name: 'workspace_search',
      description: 'Literal workspace search (bounded, read-only).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string' } }
      }
    },
    {
      name: 'git_read',
      description: 'Read-only Git status or diff (no mutation).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['operation'],
        properties: {
          operation: { type: 'string', enum: ['status', 'diff'] },
          scope: { type: 'string', enum: ['staged', 'unstaged'] },
          relativePath: { type: ['string', 'null'] }
        }
      }
    }
  ]
}

/** Exact approval summary for one validated tool invocation (inert text). */
export function approvalSummaryFor(tool: WorkerToolName, args: Record<string, unknown>): string {
  if (tool === 'workspace_read') {
    return `Read ${String(args['relativePath'] ?? '')}`
  }
  if (tool === 'workspace_search') {
    return `Search workspace for "${String(args['query'] ?? '')}"`
  }
  const operation = args['operation']
  if (operation === 'status') {
    return 'Read Git status'
  }
  const scope = args['scope']
  const relativePath = args['relativePath']
  const base = scope === 'staged' ? 'Read staged Git diff' : 'Read unstaged Git diff'
  if (typeof relativePath === 'string' && relativePath !== '') {
    return `${base} for ${relativePath}`
  }
  return base
}
