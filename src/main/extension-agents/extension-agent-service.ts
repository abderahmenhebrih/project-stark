/**
 * Generic extension-agent service (main-side).
 *
 * Discovers agent providers from installed extension manifests
 * (standard `chatParticipants` contributions — never names),
 * executes runs through the existing trust-gated bounded
 * `invokeCommand` boundary, and imports file proposals through the
 * existing Change Transaction pipeline (human Accept required).
 *
 * Safety boundary (non-negotiable):
 * - provider code NEVER touches WorkspaceFileWriteService (not even
 *   imported here) — edits become pending transactions only;
 * - prompts are session references + the trailing user message
 *   (main-derived, bounded); STARK effort is rejected, never sent;
 * - outcomes are validated (text bounds, edit bounds, path bounds)
 *   before anything persists; one bounded run, no loops, no retries.
 */

import { TextEncoder } from 'node:util'
import { join } from 'node:path'
import type { CodingMessage } from '../../shared/sessions/types'
import type {
  ExtensionAgentProviderInfo,
  ExtensionAgentRunResult
} from '../../shared/extension-agents/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { ExtensionInstallService } from '../extension-install/extension-install-service'
import type { ExtensionRuntimeService } from '../extension-host/extension-runtime-service'
import type { InstalledExtensionEntry } from '../../shared/extension-registry/types'
import { readNormalizedManifest } from '../extension-host/extension-manifest'
import { validatedInstallIdentity } from '../extension-install/extension-install-service'
import { AiOperationGuard } from '../ai/ai-operation-guard'
import { GenerationInFlightError } from '../ai/errors'
import { validateUserMessageContent } from '../sessions/message-validation'
import {
  SessionNotFoundError,
  SessionWorkspaceMismatchError,
  SessionWorkspaceUnavailableError
} from '../sessions/errors'
import { assessAgentProviders, type AssessedAgentProvider } from './extension-agent-compatibility'
import { ExtensionAgentRegistry } from './extension-agent-registry'
import {
  ExtensionAgentNotAvailableError,
  ExtensionAgentNothingToAnswerError,
  ExtensionAgentRequestError,
  ExtensionAgentResponseError
} from './extension-agent-errors'

const encoder = new TextEncoder()

/** Largest agent prompt, in exact UTF-8 bytes (matches the composer cap). */
export const AGENT_MAX_PROMPT_BYTES = 64 * 1024
/** Largest agent text response, in exact UTF-8 bytes. */
export const AGENT_MAX_TEXT_BYTES = 64 * 1024
/** Most file edits imported from one agent run. */
export const AGENT_MAX_EDIT_FILES = 5
/** Largest single proposed file, in exact UTF-8 bytes. */
export const AGENT_MAX_EDIT_FILE_BYTES = 64 * 1024
/** Longest relative path accepted from an agent edit. */
const AGENT_MAX_PATH_CHARS = 512

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
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

function cleanBoundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value === '') {
    return null
  }
  if (encoder.encode(value).byteLength > maxBytes) {
    return null
  }
  if (value.includes('\0')) {
    return null
  }
  return value
}

function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.length > AGENT_MAX_PATH_CHARS || value.includes('\0')) {
    return false
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    return false
  }
  for (const part of value.split(/[\\/]/)) {
    if (part === '..') {
      return false
    }
  }
  return true
}

export interface ExtensionAgentServiceOptions {
  readonly now?: () => number
  readonly operationGuard?: AiOperationGuard
}

export interface ExtensionAgentServiceDeps {
  readonly workspaces: WorkspaceRepository
  readonly sessions: CodingSessionRepository
  readonly files: WorkspaceFilesService
  readonly transactions: ChangeTransactionService
  readonly installService: ExtensionInstallService
  readonly installRoot: string
  readonly runtime: ExtensionRuntimeService
}

/**
 * Generic agent runtime. Constructed in the application root next to
 * the activation/runtime services and exposed over two narrow IPC
 * channels (list + run). Older harnesses omit it (no agent channels).
 */
export class ExtensionAgentService {
  private readonly now: () => number
  private readonly guard: AiOperationGuard
  private readonly registry = new ExtensionAgentRegistry()
  /** In-flight runs by `extensionId::providerId` (honest `running` state). */
  private readonly running = new Set<string>()
  /** Last manifest assessment per extension (eligible + honest ineligible rows). */
  private assessed = new Map<string, readonly AssessedAgentProvider[]>()

  constructor(private readonly deps: ExtensionAgentServiceDeps, options?: ExtensionAgentServiceOptions) {
    this.now = options?.now ?? Date.now
    this.guard = options?.operationGuard ?? new AiOperationGuard()
  }

  private runKey(extensionId: string, providerId: string): string {
    return `${extensionId}::${providerId}`
  }

  /**
   * Explicit discovery over installed extensions: re-reads manifests
   * as data, assesses agent contributions, and syncs the registry.
   * Best-effort per extension (one bad manifest never blocks the
   * rest); uninstalled extensions drop out. Returns provider count.
   */
  async refreshProviders(): Promise<number> {
    let installed: readonly InstalledExtensionEntry[]
    try {
      installed = await this.deps.installService.listInstalled()
    } catch {
      return this.registry.size()
    }
    const seen = new Set<string>()
    const assessed = new Map<string, readonly AssessedAgentProvider[]>()
    for (const entry of installed) {
      const extensionId = `${entry.namespace}.${entry.name}`
      if (seen.has(extensionId)) {
        continue
      }
      seen.add(extensionId)
      let candidates: readonly AssessedAgentProvider[]
      try {
        const identity = validatedInstallIdentity({ namespace: entry.namespace, name: entry.name, version: entry.version })
        const manifest = readNormalizedManifest(join(this.deps.installRoot, `${identity.namespace}.${identity.name}`, identity.version), identity)
        candidates = assessAgentProviders({
          namespace: identity.namespace,
          name: identity.name,
          version: identity.version,
          displayName: manifest.displayName,
          contributes: manifest.contributes
        })
      } catch {
        candidates = []
      }
      assessed.set(extensionId, candidates)
      // Sync executable providers for this extension: replace the
      // previous set so updates/disables take effect immediately.
      this.registry.unregisterForExtension(extensionId)
      if (entry.enabled) {
        for (const candidate of candidates) {
          if (!candidate.eligible || candidate.command === null) {
            continue
          }
          try {
            this.registry.register({
              extensionId,
              namespace: candidate.namespace,
              name: candidate.name,
              version: candidate.version,
              providerId: candidate.providerId,
              displayName: candidate.displayName,
              command: candidate.command,
              capabilities: { chat: true, streaming: false, tools: false, proposals: true, cancellation: false }
            })
          } catch {
            // Malformed records fail closed, one provider at a time.
          }
        }
      }
    }
    // Drop extensions that are no longer installed.
    for (const record of this.registry.list()) {
      if (!seen.has(record.extensionId)) {
        this.registry.unregisterForExtension(record.extensionId)
      }
    }
    for (const extensionId of [...assessed.keys()]) {
      if (!seen.has(extensionId)) {
        assessed.delete(extensionId)
      }
    }
    this.assessed = assessed
    return this.registry.size()
  }

  /** Sanitized provider rows for the composer target menu (no secrets, no paths). */
  async listProviders(): Promise<readonly ExtensionAgentProviderInfo[]> {
    await this.refreshProviders()
    let installed: readonly InstalledExtensionEntry[]
    try {
      installed = await this.deps.installService.listInstalled()
    } catch {
      installed = []
    }
    const enabledById = new Map<string, InstalledExtensionEntry>()
    const iconById = new Map<string, string>()
    for (const entry of installed) {
      const extensionId = `${entry.namespace}.${entry.name}`
      if (!enabledById.has(extensionId) && entry.enabled) {
        enabledById.set(extensionId, entry)
      }
      if (!iconById.has(extensionId) && entry.iconUrl !== null) {
        iconById.set(extensionId, entry.iconUrl)
      }
    }
    const rows: ExtensionAgentProviderInfo[] = []
    for (const [extensionId, candidates] of this.assessed) {
      for (const candidate of candidates) {
        const installedEntry = enabledById.get(extensionId)
        const executable = this.registry.get(extensionId, candidate.providerId)
        if (executable !== undefined && installedEntry !== undefined) {
          rows.push({
            extensionId,
            namespace: candidate.namespace,
            name: candidate.name,
            version: candidate.version,
            providerId: candidate.providerId,
            displayName: candidate.displayName,
            iconUrl: iconById.get(extensionId) ?? null,
            capabilities: { chat: true, streaming: false, tools: false, proposals: true, cancellation: false },
            availability: this.running.has(this.runKey(extensionId, candidate.providerId))
              ? { status: 'running', reason: null, version: candidate.version }
              : { status: 'available', reason: null, version: candidate.version }
          })
          continue
        }
        // Visible but disabled with an honest generic reason: never
        // executed, never faked.
        const reason =
          installedEntry === undefined && executable === undefined && candidate.eligible
            ? 'Extension is disabled.'
            : (candidate.reason ?? 'Extension does not expose a compatible agent interface.')
        rows.push({
          extensionId,
          namespace: candidate.namespace,
          name: candidate.name,
          version: candidate.version,
          providerId: candidate.providerId,
          displayName: candidate.displayName,
          iconUrl: iconById.get(extensionId) ?? null,
          capabilities: { chat: false, streaming: false, tools: false, proposals: false, cancellation: false },
          availability: { status: 'unavailable', reason, version: candidate.version }
        })
      }
    }
    return rows.sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))
  }

  /**
   * Runs one agent turn for the session's trailing user message:
   * bounded command execution, validated text persisted as the
   * assistant message, structured edits imported as pending Change
   * Transactions (human Accept required). Exactly one provider call,
   * no loops, no retries.
   */
  async runAgent(payload: unknown): Promise<ExtensionAgentRunResult> {
    // Strict contract: STARK effort and any other foreign key are
    // rejected here — extensions control their own behavior.
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId', 'extensionId', 'providerId'])) {
      throw new ExtensionAgentRequestError()
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId, extensionId, providerId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new ExtensionAgentRequestError()
    }
    if (typeof extensionId !== 'string' || extensionId === '' || typeof providerId !== 'string' || providerId === '') {
      throw new ExtensionAgentRequestError()
    }
    if (this.deps.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
    const session = this.deps.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    if (this.guard.isActive(sessionId)) {
      throw new GenerationInFlightError()
    }
    // Fresh discovery so enable/disable/update state applies to this run.
    await this.refreshProviders()
    const provider = this.registry.get(extensionId, providerId)
    if (provider === undefined) {
      throw new ExtensionAgentNotAvailableError(this.unavailableReason(extensionId, providerId))
    }
    const latest = this.deps.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      throw new ExtensionAgentNothingToAnswerError()
    }
    if (encoder.encode(latest.content).byteLength > AGENT_MAX_PROMPT_BYTES) {
      throw new ExtensionAgentRequestError()
    }
    this.guard.acquire(sessionId)
    const key = this.runKey(extensionId, providerId)
    this.running.add(key)
    try {
      return await this.runInner(workspaceId, sessionId, provider.command, latest.content)
    } finally {
      this.running.delete(key)
      this.guard.release(sessionId)
    }
  }

  private unavailableReason(extensionId: string, providerId: string): string {
    const candidates = this.assessed.get(extensionId) ?? []
    const candidate = candidates.find((entry) => entry.providerId === providerId)
    if (candidate !== undefined && candidate.reason !== null) {
      return candidate.reason
    }
    return 'Extension does not expose a compatible agent interface.'
  }

  private async runInner(
    workspaceId: number,
    sessionId: number,
    command: string,
    prompt: string
  ): Promise<ExtensionAgentRunResult> {
    // One bounded provider call through the existing trust-gated
    // command boundary (demand-driven activation, 10s timeout, 64KB
    // args). The extension receives the prompt only — never session
    // internals, credentials, or paths. Boundary errors are already
    // public-safe and propagate verbatim.
    const raw: unknown = await this.deps.runtime.invokeCommand(command, [{ prompt }])
    const { text, edits } = this.parseOutcome(raw)
    let validated: string
    try {
      validated = validateUserMessageContent(text)
    } catch {
      throw new ExtensionAgentResponseError()
    }
    const now = this.now()
    const messageId = this.deps.sessions.appendMessage({
      sessionId,
      role: 'assistant',
      content: validated,
      now,
      retitle: null
    }).messageId
    const message = this.deps.sessions.findMessageById(messageId)
    const updated = this.deps.sessions.findSessionById(sessionId)
    if (message === undefined || updated === undefined) {
      throw new SessionNotFoundError()
    }
    // Proposal import: structured whole-file edits become pending
    // Change Transactions through the existing Stage 9 path (stale
    // protection via expectedRevision). No direct writes — the human
    // must review and Accept each one. Invalid edits are dropped;
    // the delivered text is never held hostage by a bad path.
    const proposalTransactionIds: number[] = []
    for (const edit of edits) {
      try {
        const file = await this.deps.files.readTextFile({ workspaceId, relativePath: edit.relativePath })
        if (file.content === edit.proposedContent) {
          continue
        }
        const transaction = await this.deps.transactions.createFileChange({
          workspaceId,
          relativePath: edit.relativePath,
          expectedRevision: file.revision,
          proposedContent: edit.proposedContent
        })
        if (transaction.status === 'pending') {
          proposalTransactionIds.push(transaction.id)
        }
      } catch {
        // Best-effort per edit: stale/missing/invalid targets drop.
      }
    }
    return {
      session: {
        id: updated.id,
        workspaceId: updated.workspaceId,
        title: updated.title,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt
      },
      message: {
        id: message.id,
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        context: []
      } satisfies CodingMessage,
      proposalTransactionIds
    }
  }

  /** Validates one provider outcome (tolerant of extra fields, strict on what STARK consumes). */
  private parseOutcome(raw: unknown): {
    readonly text: string
    readonly edits: readonly { readonly relativePath: string; readonly proposedContent: string }[]
  } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ExtensionAgentResponseError()
    }
    const record = raw as Record<string, unknown>
    const text = cleanBoundedText(record['text'], AGENT_MAX_TEXT_BYTES)
    if (text === null) {
      throw new ExtensionAgentResponseError()
    }
    const edits: { readonly relativePath: string; readonly proposedContent: string }[] = []
    if (record['edits'] !== undefined) {
      if (!Array.isArray(record['edits'])) {
        throw new ExtensionAgentResponseError()
      }
      for (const entry of record['edits'].slice(0, AGENT_MAX_EDIT_FILES)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new ExtensionAgentResponseError()
        }
        const candidate = entry as Record<string, unknown>
        const relativePath = candidate['relativePath']
        const proposedContent = candidate['proposedContent']
        if (typeof relativePath !== 'string' || !isSafeRelativePath(relativePath)) {
          throw new ExtensionAgentResponseError()
        }
        if (
          typeof proposedContent !== 'string' ||
          proposedContent === '' ||
          encoder.encode(proposedContent).byteLength > AGENT_MAX_EDIT_FILE_BYTES ||
          proposedContent.includes('\0')
        ) {
          throw new ExtensionAgentResponseError()
        }
        edits.push({ relativePath, proposedContent })
      }
    }
    return { text, edits }
  }
}
