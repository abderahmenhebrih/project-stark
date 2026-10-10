/**
 * Shared Worker tool contract (Stage 27).
 *
 * Worker tools: workspace_read, workspace_search, git_read,
 * change_propose, attachment_import, image_generate, terminal_execute,
 * runtime_start, runtime_observe, preview_inspect. Plain TypeScript —
 * no Node/DOM APIs. Renderer never submits tool names, args, or
 * results; all derive main-side. Approval is per exact action; policy
 * never mutates on approval. change_propose targets are opaque
 * same-run readRefs (R1…); terminal_execute and runtime_start carry
 * only a bare program plus inert argv (never a shell string, cwd,
 * env, or timeout). runtime_start additionally carries the expected
 * loopback preview port — main derives the preview URL from it.
 */

/** Exactly the ten tools (eight Stage 27 plus attachment import plus image generation). */
export type WorkerToolName = 'workspace_read' | 'workspace_search' | 'git_read' | 'change_propose' | 'attachment_import' | 'image_generate' | 'terminal_execute' | 'runtime_start' | 'runtime_observe' | 'preview_inspect'

/** One requested file change inside a change_propose invocation (model supplies only opaque ref). */
export interface WorkerProposalChange {
  readonly targetRef: string
  readonly summary: string
  readonly proposedContent: string
}

/**
 * One requested attachment import inside an attachment_import
 * invocation. The model supplies ONLY the opaque chat-attachment ID
 * plus a proposed workspace destination — never a source path,
 * storage path, or absolute path. Main resolves and validates.
 */
export interface WorkerAttachmentImport {
  readonly attachmentId: string
  readonly proposedRelativePath: string
}

/**
 * One requested image generation inside an image_generate invocation.
 * The model supplies ONLY the prompt, count, and closed-vocabulary
 * options — never a provider URL, credential, filesystem destination,
 * or attachment path. Main resolves provider, stores bytes as normal
 * chat attachments, and links them to the assistant message.
 */
export interface WorkerImageGenerate {
  readonly prompt: string
  readonly count: number
  readonly size?: string
}

/** One requested terminal command (bare program plus inert argv data). */
export interface WorkerTerminalCommand {
  readonly program: string
  readonly args: readonly string[]
}

/** Discriminated tool arguments (exactly one shape per tool). */
export type WorkerToolArguments =
  | { readonly tool: 'workspace_read'; readonly relativePath: string }
  | { readonly tool: 'workspace_search'; readonly query: string }
  | { readonly tool: 'git_read'; readonly operation: 'status' }
  | { readonly tool: 'git_read'; readonly operation: 'diff'; readonly scope: 'staged' | 'unstaged'; readonly relativePath: string | null }
  | { readonly tool: 'change_propose'; readonly changes: readonly WorkerProposalChange[] }
  | { readonly tool: 'attachment_import'; readonly imports: readonly WorkerAttachmentImport[] }
  | { readonly tool: 'image_generate'; readonly prompt: string; readonly count: number; readonly size?: string }
  | { readonly tool: 'terminal_execute'; readonly program: string; readonly args: readonly string[] }
  | { readonly tool: 'runtime_start'; readonly program: string; readonly args: readonly string[]; readonly port: number }
  | { readonly tool: 'runtime_observe' }
  | { readonly tool: 'preview_inspect' }

/** Normalized tool result returned to the Worker as DATA (never authority). */
export type WorkerToolResultStatus = 'succeeded' | 'denied' | 'failed'

export interface WorkerToolResult {
  readonly status: WorkerToolResultStatus
  readonly summary: string
  readonly payload: string
  readonly reason?: string
}

/** Approval lifecycle. Terminal states never transition back. */
export type WorkerToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'

/** Renderer-safe approval (exact action, no editable args). */
export interface WorkerToolApproval {
  readonly id: number
  readonly workspaceId: number
  readonly sessionId: number
  readonly runId: number
  readonly toolName: WorkerToolName
  readonly capability: string
  readonly summary: string
  readonly detail: string
  readonly status: WorkerToolApprovalStatus
  readonly createdAt: number
  readonly decidedAt: number | null
  readonly consumedAt: number | null
}

/** Renderer-safe tool event audit row. */
export interface WorkerToolEvent {
  readonly id: number
  readonly runId: number
  readonly toolName: WorkerToolName
  readonly capability: string
  readonly summary: string
  readonly status: WorkerToolResultStatus
  readonly resultBytes: number
  readonly approvalId: number | null
  readonly createdAt: number
}

/** Pending-approval lookup request. */
export interface GetPendingApprovalRequest {
  readonly workspaceId: number
  readonly sessionId: number
}

/** Approval decision request (IDs only — main derives everything). */
export interface DecideApprovalRequest {
  readonly workspaceId: number
  readonly sessionId: number
  readonly approvalId: number
}

/** Worker-tools slice of the preload bridge. */
export interface WorkerToolsApi {
  getPendingApproval: (request: GetPendingApprovalRequest) => Promise<WorkerToolApproval | null>
  approveAndResume: (request: DecideApprovalRequest) => Promise<import('../ai/types').WorkRecoveryResult>
  denyAndResume: (request: DecideApprovalRequest) => Promise<import('../ai/types').WorkRecoveryResult>
}
