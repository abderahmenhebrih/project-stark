import { TextEncoder } from 'node:util'
import type { WorkerToolArguments, WorkerToolName, WorkerToolResult } from '../../shared/worker-tools/types'
import type { CapabilityGate } from '../capabilities/capability-gate'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import type { GitService } from '../git/git-service'
import type { ChangeSetService } from '../change-sets/change-set-service'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { ProjectRuntimeService } from '../project-runtime/project-runtime-service'
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
import {
  WORKER_RUNTIME_DENY_MESSAGE,
  WORKER_RUNTIME_INVALID_POLICY_MESSAGE,
  WORKER_RUNTIME_USER_DENY_MESSAGE,
  parseRuntimeStartArgs
} from './worker-runtime-validation'
import {
  WORKER_RUNTIME_OBSERVE_DENY_MESSAGE,
  WORKER_RUNTIME_OBSERVE_USER_DENY_MESSAGE,
  WORKER_RUNTIME_TARGET_CHANGED_MESSAGE,
  parseRuntimeObserveApprovalArgs,
  parseRuntimeObserveArgs
} from '../runtime-observation/runtime-observation-validation'
import {
  WORKER_PREVIEW_INSPECT_DENY_MESSAGE,
  WORKER_PREVIEW_USER_DENY_MESSAGE,
  parsePreviewInspectApprovalArgs,
  parsePreviewInspectArgs
} from '../preview-inspection/preview-inspection-validation'
import type { RuntimeObservationService } from '../runtime-observation/runtime-observation-service'
import type { PreviewInspectionService } from '../preview-inspection/preview-inspection-service'
import type { AttachmentImportService, AttachmentImportPreview } from '../attachment-import/attachment-import-service'
import { AttachmentImportError } from '../attachment-import/errors'
import { hashToolArgs } from './worker-tool-repository'
import { createWorkerProposal, resolveProposalTargets } from './worker-proposal-service'
import {
  WORKER_ATTACHMENT_IMPORT_DENY_MESSAGE,
  WORKER_ATTACHMENT_IMPORT_UNKNOWN_MESSAGE,
  WORKER_ATTACHMENT_IMPORT_USER_DENY_MESSAGE,
  parseAttachmentImportArgs
} from './worker-attachment-import-validation'
import type { ImageGenerationService } from '../image-generation/image-generation-service'
import {
  WORKER_IMAGE_GENERATE_DENY_MESSAGE,
  WORKER_IMAGE_GENERATE_USER_DENY_MESSAGE,
  parseImageGenerateArgs
} from '../image-generation/validation'
import { toPublicImageGenerationError } from '../image-generation/errors'

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
  if (tool === 'attachment_import') {
    // Strict shape + bounds (1–10 opaque attachment IDs plus proposed
    // destinations, no source/storage/absolute paths). Destination
    // safety, session scope, and availability are enforced at
    // execution time as bounded failed tool results.
    const parsed = parseAttachmentImportArgs(args)
    return { tool, imports: [...parsed.imports] }
  }
  if (tool === 'image_generate') {
    // Strict shape + bounds (prompt 1–4000 chars, count 1–4, closed
    // size vocabulary). The model supplies no provider URL, secret,
    // destination, or attachment path — main resolves
    // everything. Capability and availability are enforced at
    // execution time as bounded failed tool results.
    const parsed = parseImageGenerateArgs(args)
    return { tool, prompt: parsed.prompt, count: parsed.count, ...(parsed.size === undefined ? {} : { size: parsed.size }) }
  }
  if (tool === 'terminal_execute') {
    // Strict program + argv only (bare executable name, inert args, no
    // command string/cwd/env/shell/stdin/timeout extras).
    const parsed = parseTerminalExecuteArgs(args)
    return { tool, program: parsed.program, args: [...parsed.args] }
  }
  if (tool === 'runtime_start') {
    // Strict program + argv + loopback port only (same program/argv
    // rules as terminal_execute; main derives the preview URL).
    const parsed = parseRuntimeStartArgs(args)
    return { tool, program: parsed.program, args: [...parsed.args], port: parsed.port }
  }
  if (tool === 'runtime_observe') {
    // Exactly empty object — main derives the active runtime from the
    // current Workspace. No runtimeId/log-limit/PID/path authority.
    parseRuntimeObserveArgs(args)
    return { tool }
  }
  if (tool === 'preview_inspect') {
    // Exactly empty object — main derives the loopback target from
    // the active runtime and human Preview state. No URL/path
    // authority, no selectors, no JavaScript.
    parsePreviewInspectArgs(args)
    return { tool }
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
  /** Stage 26 managed runtime sessions (reservation + lifecycle). Optional for older harnesses. */
  readonly runtimes?: ProjectRuntimeService
  /** Stage 27 read-only runtime observation. Optional for older harnesses. */
  readonly runtimeObservation?: RuntimeObservationService
  /** Stage 27 read-only Preview inspection. Optional for older harnesses. */
  readonly previewInspection?: PreviewInspectionService
  /** Step 3 chat-attachment import proposals. Optional for older harnesses. */
  readonly attachmentImports?: AttachmentImportService
  /** Step 5 bounded image generation. Optional for older harnesses. */
  readonly images?: ImageGenerationService
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
 * Bounded tool executor (Stage 27): read-only tools plus one
 * reviewable-proposal tool (change_propose) plus two read-only
 * observations (runtime_observe, preview_inspect). Validates the
 * request, consults CapabilityGate (worker only), then executes
 * through the existing bounded read/search/Git/proposal/observation
 * services. Direct writers, terminal, shells, Accept/Reject/Rollback,
 * browser automation, and network fetches are never imported or
 * called — observations are bounded untrusted DATA with strict caps.
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
          : input.tool === 'attachment_import'
            ? WORKER_ATTACHMENT_IMPORT_DENY_MESSAGE
            : input.tool === 'image_generate'
              ? WORKER_IMAGE_GENERATE_DENY_MESSAGE
              : input.tool === 'terminal_execute'
              ? WORKER_TERMINAL_DENY_MESSAGE
              : input.tool === 'runtime_start'
                ? WORKER_RUNTIME_DENY_MESSAGE
                : input.tool === 'runtime_observe'
                  ? WORKER_RUNTIME_OBSERVE_DENY_MESSAGE
                  : input.tool === 'preview_inspect'
                    ? WORKER_PREVIEW_INSPECT_DENY_MESSAGE
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
    if (input.tool === 'terminal_execute' || input.tool === 'runtime_start') {
      // Defense in depth: terminal persistent Allow is forbidden, so a
      // gate `allow` for terminal.execute is an invalid policy — never
      // sufficient for execution. No process spawns here, ever.
      const result: WorkerToolResult = {
        status: 'denied',
        summary: this.summaryFor(input.tool, input.args),
        payload: '',
        reason:
          input.tool === 'terminal_execute' ? WORKER_TERMINAL_INVALID_POLICY_MESSAGE : WORKER_RUNTIME_INVALID_POLICY_MESSAGE
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
    }
    if (input.tool === 'runtime_start') {
      return await this.executeApprovedRuntime(input)
    }
    if (input.tool === 'runtime_observe') {
      return await this.executeApprovedRuntimeObserve(input)
    }
    if (input.tool === 'preview_inspect') {
      return await this.executeApprovedPreviewInspect(input)
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

  /** Denied-user copy for change_propose approval denial (persisted by the runner). */
  static userDenyMessage(): string {
    return WORKER_PROPOSAL_USER_DENY_MESSAGE
  }

  /** Denied-user copy for attachment_import approval denial (persisted by the runner). */
  static attachmentImportUserDenyMessage(): string {
    return WORKER_ATTACHMENT_IMPORT_USER_DENY_MESSAGE
  }

  /** Denied-user copy for image_generate approval denial (persisted by the runner). */
  static imageGenerateUserDenyMessage(): string {
    return WORKER_IMAGE_GENERATE_USER_DENY_MESSAGE
  }

  /** Denied-user copy for terminal_execute approval denial (persisted by the runner). */
  static terminalUserDenyMessage(): string {
    return WORKER_TERMINAL_USER_DENY_MESSAGE
  }

  /** Denied-user copy for runtime_start approval denial (persisted by the runner). */
  static runtimeUserDenyMessage(): string {
    return WORKER_RUNTIME_USER_DENY_MESSAGE
  }

  /** Denied-user copy for runtime_observe approval denial (persisted by the runner). */
  static runtimeObserveUserDenyMessage(): string {
    return WORKER_RUNTIME_OBSERVE_USER_DENY_MESSAGE
  }

  /** Denied-user copy for preview_inspect approval denial (persisted by the runner). */
  static previewInspectUserDenyMessage(): string {
    return WORKER_PREVIEW_USER_DENY_MESSAGE
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
    if (tool === 'attachment_import') {
      const imports = (args as { imports?: readonly unknown[] }).imports
      const count = Array.isArray(imports) ? imports.length : 0
      if (count === 1) {
        return 'Propose importing a chat attachment into the project'
      }
      if (count > 1) {
        return `Propose importing ${String(count)} chat attachments into the project`
      }
      return 'Propose importing a chat attachment into the project'
    }
    if (tool === 'image_generate') {
      const count = (args as { count?: unknown }).count
      if (typeof count === 'number' && count > 1) {
        return `Generate ${String(count)} images using the configured AI provider`
      }
      return 'Generate an image using the configured AI provider'
    }
    if (tool === 'terminal_execute') {
      return `Run command: ${(args as { program?: string }).program ?? ''}`
    }
    if (tool === 'runtime_start') {
      return `Start project runtime: ${(args as { program?: string }).program ?? ''}`
    }
    if (tool === 'runtime_observe') {
      return 'Observe managed runtime'
    }
    if (tool === 'preview_inspect') {
      return 'Inspect rendered Live Preview'
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
    if (input.tool === 'runtime_observe') {
      return await this.executeRuntimeObserve(input)
    }
    if (input.tool === 'preview_inspect') {
      return await this.executePreviewInspect(input)
    }
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
    if (input.tool === 'attachment_import') {
      return await this.executeAttachmentImport(input)
    }
    if (input.tool === 'image_generate') {
      return await this.executeImageGenerate(input)
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
      // Step 3: a same-run single binary import groups with this text
      // proposal so asset additions and source edits coexist in one
      // review set. Best-effort — failures keep separate transactions.
      const grouped = await this.maybeGroupRunProposals(input, [
        { transactionId: outcome.transactionId, fileSummary: outcome.files[0]?.summary ?? `Update ${path}`, kind: 'text' as const }
      ])
      if (grouped !== null) {
        const groupedPayload = JSON.stringify({
          status: 'proposal_created',
          kind: 'change_set',
          changeSetId: grouped,
          files: outcome.files
        })
        return { status: 'succeeded', summary: `Create reviewable change proposal for ${path} (grouped for review)`, payload: groupedPayload }
      }
      const payload = JSON.stringify({ status: 'proposal_created', kind: 'single', transactionId: outcome.transactionId, files: outcome.files })
      return { status: 'succeeded', summary: `Create reviewable change proposal for ${path}`, payload }
    }
    const payload = JSON.stringify({ status: 'proposal_created', kind: 'change_set', changeSetId: outcome.changeSetId, files: outcome.files })
    return { status: 'succeeded', summary: `Create reviewable change proposal for ${String(outcome.files.length)} files`, payload }
  }

  /**
   * Resolves attachment-import previews WITHOUT persisting (Step 3
   * approval-summary path). Mirrors the change_propose resolved
   * summary: exact attachment names plus destinations. Throws safe
   * import copy when the import cannot be proposed.
   */
  async describeAttachmentImports(input: {
    workspaceId: number
    sessionId: number
    imports: readonly { readonly attachmentId: string; readonly proposedRelativePath: string }[]
  }): Promise<readonly AttachmentImportPreview[]> {
    const service = this.deps.attachmentImports
    if (service === undefined) {
      throw new AttachmentImportError('We couldn’t import that attachment.')
    }
    return await service.describeImports({ workspaceId: input.workspaceId, sessionId: input.sessionId, items: input.imports })
  }

  /**
   * Executes one validated attachment_import through the Step 3
   * import service only. Creates exactly one pending binary ADD
   * transaction (single) or one Change Set (multi). Disk unchanged.
   * Zero provider calls. Scope/safety/availability failures are
   * bounded failed tool results with no partial persistence.
   */
  private async executeAttachmentImport(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const service = this.deps.attachmentImports
    const changeSets = this.deps.changeSets
    if (service === undefined || changeSets === undefined) {
      return { status: 'failed', summary: 'Propose importing a chat attachment into the project', payload: '', reason: 'Attachment imports are unavailable.' }
    }
    const raw = input.args as unknown as { imports?: unknown }
    let imports: readonly { attachmentId: string; proposedRelativePath: string }[]
    try {
      const parsed = parseAttachmentImportArgs({ imports: raw.imports })
      imports = parsed.imports
    } catch {
      return { status: 'failed', summary: 'Propose importing a chat attachment into the project', payload: '', reason: 'Attachment import arguments are invalid.' }
    }
    let outcome: Awaited<ReturnType<AttachmentImportService['proposeImports']>>
    try {
      outcome = await service.proposeImports({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        summary: `Attachment import of ${String(imports.length)} file${imports.length === 1 ? '' : 's'}`,
        items: imports
      })
    } catch (error) {
      return {
        status: 'failed',
        summary: 'Propose importing a chat attachment into the project',
        payload: '',
        reason: error instanceof AttachmentImportError ? error.message : WORKER_ATTACHMENT_IMPORT_UNKNOWN_MESSAGE
      }
    }
    if (outcome.kind === 'single') {
      const file = outcome.files[0]
      const where = file === undefined ? 'file' : `${file.fileName} to ${file.destination}`
      const files = outcome.files.map((entry) => ({
        attachmentId: entry.attachmentId,
        fileName: entry.fileName,
        destination: entry.destination,
        sizeBytes: entry.sizeBytes,
        summary: `Import ${entry.fileName} to ${entry.destination}`
      }))
      const grouped = await this.maybeGroupRunProposals(input, [
        { transactionId: outcome.transactionId, fileSummary: files[0]?.summary ?? `Import ${where}`, kind: 'binary' as const }
      ])
      if (grouped !== null) {
        const groupedPayload = JSON.stringify({ status: 'proposal_created', kind: 'change_set', changeSetId: grouped, files })
        return { status: 'succeeded', summary: `Propose importing ${where} (grouped for review)`, payload: groupedPayload }
      }
      const payload = JSON.stringify({ status: 'proposal_created', kind: 'single', transactionId: outcome.transactionId, files })
      return { status: 'succeeded', summary: `Propose importing ${where}`, payload }
    }
    const payload = JSON.stringify({
      status: 'proposal_created',
      kind: 'change_set',
      changeSetId: outcome.changeSetId,
      files: outcome.files.map((entry) => ({ attachmentId: entry.attachmentId, fileName: entry.fileName, destination: entry.destination }))
    })
    return { status: 'succeeded', summary: `Propose importing ${String(outcome.files.length)} chat attachments into the project`, payload }
  }

  /**
   * Executes one validated image_generate through the Step 5
   * generation service only. Generated bytes become NORMAL chat
   * attachments (opaque IDs, SHA-256, magic-verified) — never project
   * files. The runner links them to the final assistant message, so
   * mobility, review, and vision all reuse the existing attachment
   * system. Zero filesystem writes outside the attachment store.
   * Partial success persists valid images with a safe failed count;
   * nothing retries automatically.
   */
  private async executeImageGenerate(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const service = this.deps.images
    if (service === undefined) {
      return { status: 'failed', summary: 'Generate an image using the configured AI provider', payload: '', reason: 'Image generation is unavailable.' }
    }
    const raw = input.args as unknown as { prompt?: unknown; count?: unknown; size?: unknown }
    let prompt: string
    let count: number
    let size: string | undefined
    try {
      const parsed = parseImageGenerateArgs({ prompt: raw.prompt, count: raw.count, ...(raw.size === undefined ? {} : { size: raw.size }) })
      prompt = parsed.prompt
      count = parsed.count
      size = parsed.size
    } catch {
      return { status: 'failed', summary: 'Generate an image using the configured AI provider', payload: '', reason: 'Image request arguments are invalid.' }
    }
    let outcome: Awaited<ReturnType<ImageGenerationService['generateImages']>>
    try {
      outcome = await service.generateImages({ prompt, count, ...(size === undefined ? {} : { size }) })
    } catch (error) {
      return {
        status: 'failed',
        summary: 'Generate an image using the configured AI provider',
        payload: '',
        reason: toPublicImageGenerationError(error).message
      }
    }
    const files = outcome.images.map((entry, index) => ({
      attachmentId: entry.attachment.id,
      fileName: entry.attachment.name,
      mimeType: entry.attachment.mimeType,
      sizeBytes: entry.attachment.size,
      sha256: entry.sha256,
      position: index + 1
    }))
    const payload = JSON.stringify({
      status: 'images_generated',
      images: files,
      failedCount: outcome.failedCount
    })
    const made = files.length
    const summary =
      made === 1 && outcome.failedCount === 0
        ? 'Generated 1 image'
        : outcome.failedCount === 0
          ? `Generated ${String(made)} images`
          : `${String(made)} image${made === 1 ? '' : 's'} generated; ${String(outcome.failedCount)} image${outcome.failedCount === 1 ? '' : 's'} could not be generated.`
    return { status: 'succeeded', summary, payload }
  }

  /**
   * Best-effort mixed grouping (Step 3 §25): when a run holds both
   * freshly created single proposals and same-run single successes of
   * the other proposal kind (binary import vs text change), link them
   * into one review set so asset additions and source edits coexist.
   * Grouping is organizational only — failures leave the transactions
   * separate (still individually reviewable) and never fail the tool.
   */
  private async maybeGroupRunProposals(
    input: ExecuteToolInput,
    fresh: readonly { readonly transactionId: number; readonly fileSummary: string; readonly kind: 'binary' | 'text' }[]
  ): Promise<number | null> {
    const changeSets = this.deps.changeSets
    if (changeSets === undefined || fresh.length === 0) {
      return null
    }
    const singles: { readonly transactionId: number; readonly fileSummary: string }[] = fresh.map((entry) => ({
      transactionId: entry.transactionId,
      fileSummary: entry.fileSummary
    }))
    let hasBinary = fresh.some((entry) => entry.kind === 'binary')
    let hasText = fresh.some((entry) => entry.kind === 'text')
    for (const event of this.deps.tools.listEvents(input.runId)) {
      if (event.workspaceId !== input.workspaceId || event.sessionId !== input.sessionId) {
        continue
      }
      if (event.status !== 'succeeded' || (event.toolName !== 'change_propose' && event.toolName !== 'attachment_import')) {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(event.payload) as unknown
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue
      }
      const record = parsed as Record<string, unknown>
      if (record['status'] !== 'proposal_created' || record['kind'] !== 'single') {
        continue
      }
      if (typeof record['transactionId'] !== 'number') {
        continue
      }
      const files = record['files']
      if (!Array.isArray(files) || files.length !== 1) {
        continue
      }
      const file = files[0] as Record<string, unknown>
      const summary = typeof file['summary'] === 'string' && file['summary'] !== '' ? file['summary'] : null
      if (summary === null) {
        continue
      }
      if (singles.some((entry) => entry.transactionId === record['transactionId'])) {
        continue
      }
      singles.push({ transactionId: record['transactionId'] as number, fileSummary: summary })
      if (event.toolName === 'attachment_import') {
        hasBinary = true
      } else {
        hasText = true
      }
    }
    if (!hasBinary || !hasText || singles.length < 2) {
      return null
    }
    try {
      const grouped = await changeSets.groupTransactionsIntoSet({
        workspaceId: input.workspaceId,
        summary: `Combined attachment and code proposal (${String(singles.length)} files)`,
        items: singles
      })
      return grouped.id
    } catch {
      return null
    }
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

  /**
   * Starts one human-approved managed runtime at most once. The caller
   * must have verified the approval is pending with the exact args
   * hash; this re-parses the exact persisted args, re-runs the gate
   * (only `requires_approval` proceeds), returns the active runtime
   * when the workspace already owns one, otherwise reserves +
   * consumes the approval in ONE transaction BEFORE spawning, then
   * spawns exactly once and persists the bounded audit event. The
   * runtime outlives the Work run by design.
   */
  private async executeApprovedRuntime(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const fallbackSummary = this.summaryFor(input.tool, input.args)
    const runtimes = this.deps.runtimes
    if (runtimes === undefined) {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Project runtimes are unavailable.'
      }
      this.persist(input, result)
      return result
    }
    let program: string
    let args: readonly string[]
    let port: number
    try {
      const canonical: unknown = JSON.parse(input.argsJson) as unknown
      const validated = parseRuntimeStartArgs(canonical)
      program = validated.program
      args = validated.args
      port = validated.port
    } catch {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Runtime arguments are invalid.'
      }
      this.persist(input, result)
      return result
    }
    if (input.approvalId === null) {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'Project runtimes require exact human approval.'
      }
      this.persist(input, result)
      return result
    }
    let outcome: Awaited<ReturnType<ProjectRuntimeService['executeApprovedRuntime']>>
    try {
      outcome = await runtimes.executeApprovedRuntime({
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
    if (outcome.kind === 'active') {
      const payload = JSON.stringify({
        status: 'runtime_already_active',
        runtimeId: outcome.runtime.id,
        previewUrl: outcome.runtime.previewUrl,
        port: outcome.runtime.previewPort
      })
      const toolResult: WorkerToolResult = {
        status: 'succeeded',
        summary: `Project runtime already active: ${program}`,
        payload
      }
      this.persist(input, toolResult)
      return toolResult
    }
    if (outcome.kind === 'failed') {
      const result: WorkerToolResult = {
        status: 'failed', summary: fallbackSummary, payload: '', reason: 'The project runtime could not be started.'
      }
      this.persist(input, result)
      return result
    }
    const payload = JSON.stringify({
      status: 'runtime_started',
      runtimeId: outcome.runtimeId,
      previewUrl: outcome.previewUrl,
      port,
      program,
      args: [...args]
    })
    const toolResult: WorkerToolResult = { status: 'succeeded', summary: `Start project runtime: ${program}`, payload }
    this.persist(input, toolResult)
    return toolResult
  }

  /**
   * Read-only runtime observation for an allow decision (no approval).
   * Resolves the active managed runtime main-side and returns a
   * bounded normalized observation. Never starts/stopsополь. Zero
   * provider calls. Observations create no proposal authority.
   */
  private async executeRuntimeObserve(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const observation = this.deps.runtimeObservation
    if (observation === undefined) {
      return { status: 'failed', summary: 'Observe managed runtime', payload: '', reason: 'Runtime observation is unavailable.' }
    }
    try {
      parseRuntimeObserveArgs(JSON.parse(input.argsJson) as unknown)
    } catch {
      return { status: 'failed', summary: 'Observe managed runtime', payload: '', reason: 'Tool arguments are invalid.' }
    }
    const outcome = observation.observe(input.workspaceId)
    if (outcome.status === 'no_active_runtime') {
      return { status: 'succeeded', summary: 'Observe managed runtime (no active runtime)', payload: outcome.payloadJson }
    }
    return { status: 'succeeded', summary: outcome.summary, payload: outcome.payloadJson }
  }

  /**
   * Read-only Preview inspection for an allow decision (no approval).
   * Resolves the target main-side (visible current URL or loopback
   * root), performs exactly one bounded load maximum when a hidden
   * inspector is needed, and returns a bounded structured snapshot.
   * Never clicks, types, navigates arbitrarily, or mutates the DOM.
   */
  private async executePreviewInspect(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const inspection = this.deps.previewInspection
    if (inspection === undefined) {
      return { status: 'failed', summary: 'Inspect rendered Live Preview', payload: '', reason: 'Preview inspection is unavailable.' }
    }
    try {
      parsePreviewInspectArgs(JSON.parse(input.argsJson) as unknown)
    } catch {
      return { status: 'failed', summary: 'Inspect rendered Live Preview', payload: '', reason: 'Tool arguments are invalid.' }
    }
    const outcome = await inspection.inspect(input.workspaceId)
    if (outcome.status === 'preview_unavailable') {
      return { status: 'succeeded', summary: 'Inspect rendered Live Preview (unavailable)', payload: outcome.payloadJson }
    }
    return { status: 'succeeded', summary: 'Inspect rendered Live Preview', payload: outcome.payloadJson }
  }

  /**
   * Executes one human-approved runtime observation exactly once. The
   * caller must have verified the approval is pending with the exact
   * args hash; this re-parses the main-owned `{runtimeId}`, re-runs
   * the gate (deny fails closed), and observes ONLY when the bound
   * runtime is still the active starting/running session. A replaced
   * or interrupted runtime fails safely with no retargeting.
   */
  private async executeApprovedRuntimeObserve(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const fallbackSummary = 'Observe managed runtime'
    const observation = this.deps.runtimeObservation
    if (observation === undefined) {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Runtime observation is unavailable.' }
      this.persist(input, result)
      return result
    }
    let runtimeId: number
    try {
      const canonical: unknown = JSON.parse(input.argsJson) as unknown
      runtimeId = parseRuntimeObserveApprovalArgs(canonical).runtimeId
    } catch {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Approval arguments are invalid.' }
      this.persist(input, result)
      return result
    }
    if (input.approvalId === null) {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Runtime observation requires exact human approval.' }
      this.persist(input, result)
      return result
    }
    const decision = this.deps.gate.authorize({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: 'worker',
      capability: 'runtime.observe'
    })
    if (decision.decision === 'deny') {
      const result: WorkerToolResult = { status: 'denied', summary: fallbackSummary, payload: '', reason: WORKER_RUNTIME_OBSERVE_DENY_MESSAGE }
      this.persist(input, result)
      return result
    }
    const outcome = observation.observeBound(input.workspaceId, runtimeId)
    if (outcome === null) {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: WORKER_RUNTIME_TARGET_CHANGED_MESSAGE }
      this.persist(input, result)
      return result
    }
    const toolResult: WorkerToolResult = { status: 'succeeded', summary: outcome.summary, payload: outcome.payloadJson }
    this.persist(input, toolResult)
    return toolResult
  }

  /**
   * Executes one human-approved Preview inspection exactly once. The
   * caller must have verified the approval is pending with the exact
   * args hash; this re-parses the main-owned
   * `{runtimeId, targetPathAndQueryAndHash}`, re-runs the gate (deny
   * fails closed), and inspects the FROZEN path in an isolated hidden
   * window. The human Preview is never navigated or mutated.
   */
  private async executeApprovedPreviewInspect(input: ExecuteToolInput): Promise<WorkerToolResult> {
    const fallbackSummary = 'Inspect rendered Live Preview'
    const inspection = this.deps.previewInspection
    if (inspection === undefined) {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Preview inspection is unavailable.' }
      this.persist(input, result)
      return result
    }
    let runtimeId: number
    let targetPath: string
    try {
      const canonical: unknown = JSON.parse(input.argsJson) as unknown
      const validated = parsePreviewInspectApprovalArgs(canonical)
      runtimeId = validated.runtimeId
      targetPath = validated.targetPathAndQueryAndHash
    } catch {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Approval arguments are invalid.' }
      this.persist(input, result)
      return result
    }
    if (input.approvalId === null) {
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason: 'Preview inspection requires exact human approval.' }
      this.persist(input, result)
      return result
    }
    const decision = this.deps.gate.authorize({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: 'worker',
      capability: 'preview.inspect'
    })
    if (decision.decision === 'deny') {
      const result: WorkerToolResult = { status: 'denied', summary: fallbackSummary, payload: '', reason: WORKER_PREVIEW_INSPECT_DENY_MESSAGE }
      this.persist(input, result)
      return result
    }
    const outcome = await inspection.inspect(input.workspaceId, { runtimeId, targetPathAndQueryAndHash: targetPath })
    if (outcome.status === 'preview_unavailable') {
      let reason = 'The local Preview could not be inspected.'
      try {
        const parsed: unknown = JSON.parse(outcome.payloadJson) as unknown
        if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['status'] === 'runtime_target_changed') {
          reason = WORKER_RUNTIME_TARGET_CHANGED_MESSAGE
        }
      } catch {
        // Keep generic copy.
      }
      const result: WorkerToolResult = { status: 'failed', summary: fallbackSummary, payload: '', reason }
      this.persist(input, result)
      return result
    }
    const toolResult: WorkerToolResult = { status: 'succeeded', summary: fallbackSummary, payload: outcome.payloadJson }
    this.persist(input, toolResult)
    return toolResult
  }
}
