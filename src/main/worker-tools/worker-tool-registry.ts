import type { AgentCapability } from '../../shared/capabilities/types'
import type { WorkerToolName } from '../../shared/worker-tools/types'

/**
 * Static Worker tool registry (Stage 25): exactly five tools —
 * three read-only, one reviewable-proposal, one exact-approval
 * terminal command — mapped to Stage 22 capabilities. Main-owned —
 * never from renderer, provider, or Brain/Worker output.
 */

export const WORKER_TOOLS: readonly WorkerToolName[] = ['workspace_read', 'workspace_search', 'git_read', 'change_propose', 'terminal_execute']

const TOOL_TO_CAPABILITY: Readonly<Record<WorkerToolName, AgentCapability>> = {
  workspace_read: 'workspace.read',
  workspace_search: 'workspace.search',
  git_read: 'git.read',
  change_propose: 'change.propose',
  terminal_execute: 'terminal.execute'
}

const KNOWN: ReadonlySet<string> = new Set<string>(WORKER_TOOLS)

/** True for exactly the five known tools. */
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
      description: 'Read one workspace text file (bounded, read-only). Returns an opaque readRef authorizing a later proposal.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['relativePath'],
        properties: { relativePath: { type: 'string' } }
      }
    },
    {
      name: 'workspace_search',
      description: 'Literal workspace search (bounded, read-only). Previews only; never proposal authority.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string' } }
      }
    },
    {
      name: 'git_read',
      description: 'Read-only Git status or diff (no mutation). Never proposal authority.',
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
    },
    {
      name: 'change_propose',
      description: 'Create a reviewable code proposal only for files already read successfully in this run (opaque targetRef like R1). Never writes files; human review required.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['changes'],
        properties: {
          changes: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['targetRef', 'summary', 'proposedContent'],
              properties: {
                targetRef: { type: 'string' },
                summary: { type: 'string' },
                proposedContent: { type: 'string' }
              }
            }
          }
        }
      }
    },
    {
      name: 'terminal_execute',
      description: 'Run one bounded non-interactive external command with human approval for the exact program and arguments. Never runs without approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['program', 'args'],
        properties: {
          program: { type: 'string' },
          args: { type: 'array', maxItems: 32, items: { type: 'string' } }
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
  if (tool === 'change_propose') {
    // Fallback when resolved paths are unavailable (validation failed
    // before resolution). Resolved summaries are built by the proposal
    // helper and carry exact relative paths.
    const changes = args['changes']
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
    return `Run command: ${String(args['program'] ?? '')}`
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
