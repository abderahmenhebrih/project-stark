import { TextEncoder } from 'node:util'
import type {
  CreateLooplinkResult,
  LooplinkChangeReference,
  LooplinkContextItem,
  LooplinkMessage,
  LooplinkPayloadV1,
  LooplinkPreview
} from '../../shared/looplink/types'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { ChangeSetRepository } from '../database/repositories/change-set-repository'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { LooplinkRepository } from './looplink-repository'
import type { AiOperationGuard } from '../ai/ai-operation-guard'
import { SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'
import { MAX_SESSION_TITLE_CODEPOINTS } from '../sessions/limits'
import {
  InvalidLooplinkRequestError,
  LooplinkNoUserWorkError,
  LooplinkNotPendingError,
  LooplinkPayloadTooLargeError,
  LooplinkSourceBusyError
} from './looplink-errors'
import {
  MAX_LOOPLINK_CHANGE_REFERENCES,
  MAX_LOOPLINK_MESSAGES,
  MAX_LOOPLINK_MESSAGE_CANDIDATES,
  MAX_LOOPLINK_PAYLOAD_BYTES,
  MAX_LOOPLINK_WORKER_RESULT_BYTES,
  MAX_RECENT_LOOPLINKS
} from './looplink-limits'
import { byteLengthOf, hashLooplinkPayload, serializeLooplinkPayload, verifyLooplinkPayload } from './looplink-payload'

const encoder = new TextEncoder()

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

function countCodePoints(value: string): number {
  return [...value].length
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

/** Continuation title reusing the session 80-codepoint bound. */
export function deriveContinuationTitle(sourceTitle: string): string {
  const collapsed = `Continue: ${sourceTitle}`.trim().replace(/\s+/g, ' ')
  if (countCodePoints(collapsed) <= MAX_SESSION_TITLE_CODEPOINTS) {
    return collapsed
  }
  return `${[...collapsed].slice(0, MAX_SESSION_TITLE_CODEPOINTS).join('')}…`
}

/** Deterministic provider-facing continuity block. Data only, never an instruction. */
export function formatLooplinkBlock(
  sourceTitle: string,
  messages: readonly LooplinkMessage[],
  context: readonly LooplinkContextItem[],
  planSummary: string | null
): string {
  const lines: string[] = []
  lines.push('[LOOPLINK CONTINUITY — HISTORICAL SNAPSHOT]')
  lines.push(`Source session: ${sourceTitle}`)
  lines.push('Recent conversation:')
  for (const entry of messages) {
    lines.push(`${entry.role === 'assistant' ? 'STARK' : 'YOU'}: ${entry.content}`)
  }
  if (context.length > 0) {
    lines.push('Historical explicitly attached context (snapshot, not current disk state):')
    for (const item of context) {
      const where =
        item.relativePath === null ? item.label : `${item.relativePath} lines ${String(item.lineStart ?? '')}-${String(item.lineEnd ?? '')}`
      lines.push(`[${item.kind} ${where}]`)
      lines.push(item.content)
    }
  }
  if (planSummary !== null) {
    lines.push(`Latest plan: ${planSummary}`)
  }
  lines.push('[END LOOPLINK]')
  lines.push('Use the historical Looplink snapshot as context, but follow the current target-session user request.')
  return lines.join('\n')
}

/**
 * Looplink domain service (Stage 20): explicit persistent continuity.
 * Snapshots bounded already-persisted user-visible state from the
 * database only — zero provider calls, zero filesystem reads. Target
 * creation is atomic with the handoff row.
 */
export class LooplinkService {
  private readonly now: () => number

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly sessions: CodingSessionRepository,
    private readonly looplinks: LooplinkRepository,
    private readonly guard: AiOperationGuard,
    private readonly runs?: OrchestrationRepository,
    private readonly changeSetRows?: ChangeSetRepository,
    private readonly changeTxRows?: ChangeTransactionRepository,
    now: () => number = Date.now,
    private readonly recoveryStore?: {
      findEventByHandoff(handoffId: number): { id: number; status: string } | undefined
      dismissHandoffReady(eventId: number, handoffId: number, now: number): boolean
    }
  ) {
    this.now = now
  }

  /**
   * Explicit continuation: snapshots source state, creates the target
   * session plus its pending handoff atomically. Sends nothing, calls
   * no provider, starts no AI work.
   */
  async createContinuation(raw: unknown): Promise<CreateLooplinkResult> {
    if (!hasStrictShape(raw, ['workspaceId', 'sourceSessionId'])) {
      throw new InvalidLooplinkRequestError('continuation request is invalid')
    }
    const record = raw as Record<string, unknown>
    const { workspaceId, sourceSessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sourceSessionId)) {
      throw new InvalidLooplinkRequestError('session reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    const source = this.sessions.findSessionById(sourceSessionId)
    if (source === undefined) {
      throw new SessionNotFoundError()
    }
    if (source.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    if (this.guard.isActive(sourceSessionId)) {
      throw new LooplinkSourceBusyError()
    }
    const built = await this.buildPayload(workspaceId, sourceSessionId, source.title)
    const serialized = serializeLooplinkPayload(built.payload)
    const payloadBytes = byteLengthOf(serialized)
    if (payloadBytes > MAX_LOOPLINK_PAYLOAD_BYTES) {
      throw new InvalidLooplinkRequestError('continuity snapshot is too large')
    }
    const timestamp = this.now()
    const { targetSessionId, handoffId } = this.looplinks.createContinuation({
      workspaceId,
      sourceSessionId,
      targetTitle: deriveContinuationTitle(source.title),
      sourceRunId: built.sourceRunId,
      payload: serialized,
      payloadBytes,
      payloadHash: hashLooplinkPayload(serialized),
      omittedMessageCount: built.payload.omissions.messageCount,
      omittedContextCount: built.payload.omissions.contextCount,
      workerResultOmitted: built.payload.omissions.workerResultOmitted,
      omittedChangeCount: built.payload.omissions.changeCount,
      now: timestamp
    })
    const target = this.sessions.findSessionById(targetSessionId)
    const stored = this.looplinks.findById(handoffId)
    if (target === undefined || stored === undefined) {
      throw new InvalidLooplinkRequestError('continuation could not be completed')
    }
    return {
      targetSession: {
        id: target.id,
        workspaceId: target.workspaceId,
        title: target.title,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt
      },
      looplink: this.toPreview(stored, source.title)
    }
  }

  /** Pending handoff for one target session, verified, or null. */
  async getForSession(raw: unknown): Promise<LooplinkPreview | null> {
    const { workspaceId, sessionId } = this.parseSessionScope(raw)
    this.requireWorkspace(workspaceId)
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const stored = this.looplinks.findByTargetSession(sessionId)
    if (stored === undefined || stored.status !== 'pending') {
      return null
    }
    if (stored.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const payload = verifyLooplinkPayload(stored.payload, stored.payloadHash)
    const source = this.sessions.findSessionById(stored.sourceSessionId)
    return this.toPreview(stored, source?.title ?? 'Session', payload)
  }

  /** Dismisses a pending handoff; the target session remains. */
  async dismissForSession(raw: unknown): Promise<LooplinkPreview> {
    const { workspaceId, sessionId } = this.parseSessionScope(raw)
    this.requireWorkspace(workspaceId)
    const session = this.sessions.findSessionById(sessionId)
    if (session === undefined) {
      throw new SessionNotFoundError()
    }
    if (session.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const stored = this.looplinks.findByTargetSession(sessionId)
    if (stored === undefined || stored.status !== 'pending') {
      throw new LooplinkNotPendingError()
    }
    if (stored.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    // Coupled recovery dismissal (Stage 21): when the handoff backs a
    // handoff_ready recovery event, dismiss both atomically in one
    // transaction. No provider calls.
    const linked = this.recoveryStore?.findEventByHandoff(stored.id)
    if (linked !== undefined && linked.status === 'handoff_ready') {
      const timestamp = this.now()
      try {
        this.recoveryStore?.dismissHandoffReady(linked.id, stored.id, timestamp)
      } catch {
        // Fall through to the plain transition below; the recovery
        // dismiss IPC remains the atomic canonical path.
      }
      const updated = this.looplinks.findById(stored.id)
      if (updated !== undefined && updated.status === 'dismissed') {
        const source = this.sessions.findSessionById(updated.sourceSessionId)
        return this.toPreview(updated, source?.title ?? 'Session')
      }
    }
    const transitioned = this.looplinks.transition(stored.id, 'dismissed', this.now())
    if (!transitioned) {
      throw new LooplinkNotPendingError()
    }
    const updated = this.looplinks.findById(stored.id)
    if (updated === undefined) {
      throw new LooplinkNotPendingError()
    }
    const source = this.sessions.findSessionById(updated.sourceSessionId)
    return this.toPreview(updated, source?.title ?? 'Session')
  }

  /**
   * Pending continuity for AI paths: verified block plus handoff id,
   * or null. Read-only; consumption happens atomically with the
   * assistant persistence in the caller's completion primitive.
   */
  getPendingBlock(
    workspaceId: number,
    sessionId: number
  ): { looplinkId: number; block: string } | null {
    return this.getPendingBlockExcluding(workspaceId, sessionId, null)
  }

  /**
   * Recovery continuity with active-request dedup (Stage 21): when
   * the target replay text equals the latest source user message
   * already present in the snapshot, that single historical entry is
   * excluded from the rendered block so the recovery model sees the
   * active request exactly once. Stored payload is never mutated —
   * formatting at injection time only. Older history remains.
   */
  getPendingBlockExcluding(
    workspaceId: number,
    sessionId: number,
    excludeText: string | null
  ): { looplinkId: number; block: string } | null {
    const stored = this.looplinks.findByTargetSession(sessionId)
    if (stored === undefined || stored.status !== 'pending' || stored.workspaceId !== workspaceId) {
      return null
    }
    const payload = verifyLooplinkPayload(stored.payload, stored.payloadHash)
    const source = this.sessions.findSessionById(stored.sourceSessionId)
    let messages = payload.messages
    if (excludeText !== null) {
      let dropIndex = -1
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const entry = messages[index]
        if (entry !== undefined && entry.role === 'user' && entry.content === excludeText) {
          dropIndex = index
          break
        }
      }
      if (dropIndex >= 0) {
        messages = [...messages.slice(0, dropIndex), ...messages.slice(dropIndex + 1)]
      }
    }
    const block = formatLooplinkBlock(
      source?.title ?? 'Session',
      messages,
      payload.explicitContext,
      payload.orchestration?.planSummary ?? null
    )
    return { looplinkId: stored.id, block }
  }

  /**
   * Recovery snapshot builder (Stage 21, main-internal): snapshots
   * bounded already-persisted source state for one atomic recovery
   * target aggregate. Zero provider calls, zero filesystem reads.
   * The caller persists session + handoff + event atomically; this
   * method only reads. Throws the same safe errors as explicit
   * continuation when no user work exists.
   */
  async buildRecoverySnapshot(
    workspaceId: number,
    sourceSessionId: number
  ): Promise<{
    sourceTitle: string
    sourceRunId: number | null
    payload: LooplinkPayloadV1
    serialized: string
    payloadBytes: number
    payloadHash: string
  }> {
    this.requireWorkspace(workspaceId)
    const source = this.sessions.findSessionById(sourceSessionId)
    if (source === undefined) {
      throw new SessionNotFoundError()
    }
    if (source.workspaceId !== workspaceId) {
      throw new SessionWorkspaceMismatchError()
    }
    const built = await this.buildPayload(workspaceId, sourceSessionId, source.title)
    const serialized = serializeLooplinkPayload(built.payload)
    const payloadBytes = byteLengthOf(serialized)
    if (payloadBytes > MAX_LOOPLINK_PAYLOAD_BYTES) {
      throw new InvalidLooplinkRequestError('continuity snapshot is too large')
    }
    return {
      sourceTitle: source.title,
      sourceRunId: built.sourceRunId,
      payload: built.payload,
      serialized,
      payloadBytes,
      payloadHash: hashLooplinkPayload(serialized)
    }
  }

  /** Recent handoffs created from one source session, newest first. */
  listRecentFromSource(sourceSessionId: number): { id: number; status: string }[] {
    return this.looplinks
      .listRecentFromSource(sourceSessionId, MAX_RECENT_LOOPLINKS)
      .map((entry) => ({ id: entry.id, status: entry.status }))
  }

  private requireWorkspace(workspaceId: number): void {
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new SessionWorkspaceUnavailableError()
    }
  }

  private parseSessionScope(raw: unknown): { workspaceId: number; sessionId: number } {
    if (!hasStrictShape(raw, ['workspaceId', 'sessionId'])) {
      throw new InvalidLooplinkRequestError('continuity request is invalid')
    }
    const record = raw as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidLooplinkRequestError('session reference is invalid')
    }
    return { workspaceId, sessionId }
  }

  private toPreview(
    stored: {
      id: number
      status: 'pending' | 'consumed' | 'dismissed'
      payload: string
      payloadHash: string
      createdAt: number
      consumedAt: number | null
      dismissedAt: number | null
    },
    sourceTitle: string,
    parsed?: LooplinkPayloadV1
  ): LooplinkPreview {
    const payload = parsed ?? verifyLooplinkPayload(stored.payload, stored.payloadHash)
    void stored.consumedAt
    void stored.dismissedAt
    return {
      id: stored.id,
      status: stored.status,
      sourceTitle,
      createdAt: stored.createdAt,
      payload
    }
  }

  private async buildPayload(
    workspaceId: number,
    sourceSessionId: number,
    sourceTitle: string
  ): Promise<{ payload: LooplinkPayloadV1; sourceRunId: number | null }> {
    // Bounded newest-first candidates; selection below is chronological.
    // Never reads the looplink table: snapshots derive from the
    // session's own persisted messages/context, so chained sessions
    // cannot nest raw payloads.
    const candidates = this.sessions.listMessagesNewestFirst(
      sourceSessionId,
      MAX_LOOPLINK_MESSAGE_CANDIDATES,
      null
    )
    if (!candidates.some((entry) => entry.role === 'user')) {
      throw new LooplinkNoUserWorkError()
    }
    const newestFirst = [...candidates]
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_LOOPLINK_MESSAGES)
    const messageIds = newestFirst.map((entry) => entry.id)
    const contextByMessage = this.sessions.listContextForMessages(messageIds)
    const anchor = [...newestFirst].find(
      (entry) => entry.role === 'user' && (contextByMessage.get(entry.id) ?? []).length > 0
    )
    const anchorContext = anchor === undefined ? [] : (contextByMessage.get(anchor.id) ?? [])
    const recentRuns = this.runs?.listRecentForSession(sourceSessionId, 1) ?? []
    const runHeader = recentRuns[0] ?? null
    let orchestration: LooplinkPayloadV1['orchestration'] = null
    let sourceRunId: number | null = null
    if (runHeader !== undefined && runHeader !== null) {
      const steps = this.runs?.findSteps(runHeader.id) ?? []
      const workerStep = steps.find((step) => step.kind === 'worker')
      const workerOutput = workerStep?.output ?? null
      const workerBytes = workerOutput === null ? 0 : utf8Bytes(workerOutput)
      const omitWorker = workerOutput !== null && workerBytes > MAX_LOOPLINK_WORKER_RESULT_BYTES
      orchestration = {
        status: runHeader.status,
        action: runHeader.action,
        planSummary: runHeader.planSummary,
        workerResult: omitWorker ? null : workerOutput,
        workerResultOmitted: omitWorker
      }
      sourceRunId = runHeader.id
    }
    const { refs: changeRefs, omitted: omittedChangeCount } = await this.collectChangeReferences(workspaceId)
    // Shrink oldest messages until the packet fits; the anchor follows
    // the surviving messages. Whole messages only — never cut text.
    let selected = newestFirst
    let omittedMessageCount = Math.max(0, candidates.length - selected.length)
    while (true) {
      const survivingIds = new Set(selected.map((entry) => entry.id))
      const survivingAnchor = anchor !== undefined && survivingIds.has(anchor.id) ? anchorContext : []
      const candidate = this.assemblePayload(
        sourceSessionId,
        sourceTitle,
        selected,
        survivingAnchor,
        orchestration,
        changeRefs
      )
      if (utf8Bytes(serializeLooplinkPayload(candidate)) <= MAX_LOOPLINK_PAYLOAD_BYTES) {
        let contextCount = 0
        for (const entry of selected) {
          const rows = contextByMessage.get(entry.id) ?? []
          if (anchor === undefined || entry.id !== anchor.id) {
            contextCount += rows.length
          }
        }
        if (anchor !== undefined && !survivingIds.has(anchor.id)) {
          contextCount += anchorContext.length
        }
        return {
          payload: {
            ...candidate,
            omissions: {
              messageCount: omittedMessageCount,
              contextCount,
              workerResultOmitted: orchestration?.workerResultOmitted ?? false,
              changeCount: omittedChangeCount
            }
          },
          sourceRunId
        }
      }
      if (selected.length <= 1) {
        throw new LooplinkPayloadTooLargeError()
      }
      selected = selected.slice(0, selected.length - 1)
      omittedMessageCount += 1
    }
  }

  private assemblePayload(
    sourceSessionId: number,
    sourceTitle: string,
    selectedNewestFirst: readonly { id: number; role: 'user' | 'assistant'; content: string; createdAt: number }[],
    anchorContext: readonly {
      kind: LooplinkContextItem['kind']
      label: string
      relativePath: string | null
      lineStart: number | null
      lineEnd: number | null
      content: string
    }[],
    orchestration: LooplinkPayloadV1['orchestration'],
    changes: readonly LooplinkChangeReference[]
  ): LooplinkPayloadV1 {
    const messages: LooplinkMessage[] = [...selectedNewestFirst]
      .sort((a, b) => a.id - b.id)
      .map((entry) => ({ role: entry.role, content: entry.content, createdAt: entry.createdAt }))
    return {
      version: 1,
      source: { sessionId: sourceSessionId, title: sourceTitle },
      messages,
      explicitContext: anchorContext.map((entry) => ({ ...entry })),
      orchestration,
      changes: [...changes],
      omissions: { messageCount: 0, contextCount: 0, workerResultOmitted: false, changeCount: 0 }
    }
  }

  private async collectChangeReferences(workspaceId: number): Promise<{ refs: LooplinkChangeReference[]; omitted: number }> {
    const candidates: LooplinkChangeReference[] = []
    const changeSetRows = this.changeSetRows
    const changeTxRows = this.changeTxRows
    if (changeSetRows === undefined || changeTxRows === undefined) {
      return { refs: [], omitted: 0 }
    }
    for (const header of changeSetRows.listRecentForWorkspace(workspaceId, MAX_RECENT_LOOPLINKS)) {
      const links = changeSetRows.findItems(header.id)
      const statuses: string[] = []
      const rows: { link: (typeof links)[number]; path: string; status: string; fileSummary: string }[] = []
      for (const link of links) {
        const tx = changeTxRows.findTransaction(link.transactionId)
        if (tx === undefined) {
          continue
        }
        const files = changeTxRows.findFiles(tx.id)
        statuses.push(tx.status)
        rows.push({
          link,
          path: files[0]?.relativePath ?? 'change',
          status: tx.status,
          fileSummary: link.fileSummary
        })
      }
      const groupStatus =
        statuses.every((status) => status === 'pending')
          ? 'pending'
          : statuses.some((status) => status === 'pending')
            ? 'partially_resolved'
            : 'resolved'
      for (const row of rows) {
        candidates.push({
          kind: 'change-set-item',
          transactionId: row.link.transactionId,
          changeSetId: header.id,
          relativePath: row.path,
          summary: row.fileSummary,
          status: row.status,
          groupStatus
        })
      }
    }
    {
      const included = new Set(candidates.map((entry) => entry.transactionId))
      const recent = changeTxRows.listRecentForWorkspace(workspaceId, MAX_RECENT_LOOPLINKS)
      for (const tx of recent) {
        if (included.has(tx.id)) {
          continue
        }
        const files = changeTxRows.findFiles(tx.id)
        candidates.push({
          kind: 'transaction',
          transactionId: tx.id,
          changeSetId: null,
          relativePath: files[0]?.relativePath ?? 'change',
          summary: files[0]?.relativePath ?? 'change',
          status: tx.status,
          groupStatus: null
        })
      }
    }
    return {
      refs: candidates.slice(0, MAX_LOOPLINK_CHANGE_REFERENCES),
      omitted: Math.max(0, candidates.length - MAX_LOOPLINK_CHANGE_REFERENCES)
    }
  }
}
