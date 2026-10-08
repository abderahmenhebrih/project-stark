import type { AskRecoveryResult, WorkRecoveryResult } from '../../shared/ai/types'
import type { CodingSession } from '../../shared/sessions/types'
import type { RecoveryConfig, RecoveryEvent, RecoveryOperation } from '../../shared/recovery/types'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { OrchestrationRepository } from '../database/repositories/orchestration-repository'
import type { AiCompletionService } from '../ai/ai-completion-service'
import type { AiBrainService } from '../ai/ai-brain-service'
import type { LooplinkService } from '../looplink/looplink-service'
import type { LooplinkRepository } from '../looplink/looplink-repository'
import { SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'
import { validateUserMessageContent } from '../sessions/message-validation'
import { decideRecovery, failureCategoryFor } from './recovery-policy'
import type { RecoveryRepository } from './recovery-repository'
import { deriveRecoveryTitle } from './recovery-repository'
import { byteLengthOf, hashLooplinkPayload, serializeLooplinkPayload } from '../looplink/looplink-payload'
import { MAX_LOOPLINK_PAYLOAD_BYTES } from '../looplink/looplink-limits'
import { InvalidRecoveryRequestError } from './recovery-errors'
import type { RecoveryService } from './recovery-service'
import { ToolInteractiveError } from '../worker-tools/worker-tool-errors'

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

function toPublicSession(stored: {
  readonly id: number
  readonly workspaceId: number
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
}): CodingSession {
  return {
    id: stored.id,
    workspaceId: stored.workspaceId,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  }
}

function toRecoveryEvent(
  stored: {
    readonly id: number
    readonly workspaceId: number
    readonly sourceSessionId: number
    readonly targetSessionId: number
    readonly sourceMessageId: number
    readonly looplinkHandoffId: number
    readonly operation: string
    readonly failureCategory: string
    readonly policyMode: string
    readonly status: string
    readonly attemptCount: number
    readonly targetUserMessageId: number | null
    readonly targetAssistantMessageId: number | null
    readonly targetRunId: number | null
    readonly createdAt: number
    readonly updatedAt: number
    readonly completedAt: number | null
  },
  routes: RecoveryEvent['routes']
): RecoveryEvent {
  return {
    id: stored.id,
    workspaceId: stored.workspaceId,
    sourceSessionId: stored.sourceSessionId,
    targetSessionId: stored.targetSessionId,
    sourceMessageId: stored.sourceMessageId,
    looplinkHandoffId: stored.looplinkHandoffId,
    operation: stored.operation as RecoveryOperation,
    failureCategory: stored.failureCategory,
    policyMode: stored.policyMode,
    status: stored.status as RecoveryEvent['status'],
    attemptCount: stored.attemptCount,
    targetUserMessageId: stored.targetUserMessageId,
    targetAssistantMessageId: stored.targetAssistantMessageId,
    targetRunId: stored.targetRunId,
    routes,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    completedAt: stored.completedAt
  }
}

/** Coordinator results reuse the canonical shared discriminated types. */
export type { AskRecoveryResult, WorkRecoveryResult }

export interface RecoveryCoordinatorDeps {
  readonly workspaces: WorkspaceRepository
  readonly sessions: CodingSessionRepository
  readonly orchestrationRuns?: OrchestrationRepository
  readonly completion: AiCompletionService
  readonly brain?: AiBrainService
  readonly looplinkService: LooplinkService
  readonly looplinkStore: LooplinkRepository
  readonly recoveryStore: RecoveryRepository
  readonly recoveryService: RecoveryService
}

export interface RecoveryCoordinatorOptions {
  readonly now?: () => number
}

/**
 * Single-hop recovery coordinator (Stage 21): wraps production Ask
 * and Work execution with exactly one bounded recovery handoff. It
 * never replaces the underlying AI services and never retries the
 * same or recovery provider. At most one Looplink target, one
 * recovery route per role, one recovery attempt — then STOP.
 *
 * Primary Ask: max 1 call. Recovery Ask: max 1 call (total <= 2).
 * Primary Work: max 3 calls. Recovery Work: max 3 calls (total <= 6).
 * Policy, Looplink preparation, and config resolution: 0 calls.
 */
export class AiRecoveryCoordinator {
  private readonly now: () => number

  constructor(
    private readonly deps: RecoveryCoordinatorDeps,
    options?: RecoveryCoordinatorOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  /** Ask with single-hop recovery. Proposals never route here. */
  async ask(payload: unknown): Promise<AskRecoveryResult> {
    const parsed = this.parseScope(payload)
    let sourceMessageId: number | null = null
    let sourceText: string | null = null
    try {
      const found = this.latestUserMessage(parsed.sessionId)
      if (found !== null) {
        sourceMessageId = found.id
        sourceText = found.content
      }
    } catch {
      sourceMessageId = null
    }
    try {
      const result = await this.deps.completion.generateResponse(payload)
      return { kind: 'completed', result }
    } catch (primaryError) {
      const failureCategory = failureCategoryFor(primaryError)
      const config = this.safeConfig()
      const isTarget = this.isRecoveryTarget(parsed.sessionId)
      const existing =
        sourceMessageId === null
          ? undefined
          : this.deps.recoveryStore.findEventBySource(parsed.sessionId, sourceMessageId, 'ask')
      // Duplicate source failure: reuse the existing event, never a
      // second target. No additional provider call.
      if (existing !== undefined) {
        const routes = this.deps.recoveryStore.listRoutes(existing.id)
        const target = this.requireSession(parsed.workspaceId, existing.targetSessionId)
        return {
          kind: 'recovery_handoff',
          targetSession: target,
          recoveryEvent: toRecoveryEvent(existing, routes),
          failureCategory: existing.failureCategory
        }
      }
      const decision = decideRecovery({
        mode: config.mode,
        failureCategory,
        isRecoveryTarget: isTarget,
        existingEvent: false
      })
      if (decision === 'none' || failureCategory === null || sourceMessageId === null || sourceText === null) {
        throw primaryError
      }
      if (decision === 'handoff') {
        const built = await this.createHandoffTarget({
          workspaceId: parsed.workspaceId,
          sourceSessionId: parsed.sessionId,
          sourceMessageId,
          operation: 'ask',
          failureCategory,
          policyMode: 'handoff',
          replayText: null,
          routes: []
        })
        return {
          kind: 'recovery_handoff',
          targetSession: built.targetSession,
          recoveryEvent: built.event,
          failureCategory
        }
      }
      // auto_once: assignments are required by config validation.
      const askAssignment = config.ask
      if (askAssignment === null) {
        throw primaryError
      }
      const replay = validateUserMessageContent(sourceText)
      const built = await this.createHandoffTarget({
        workspaceId: parsed.workspaceId,
        sourceSessionId: parsed.sessionId,
        sourceMessageId,
        operation: 'ask',
        failureCategory,
        policyMode: 'auto_once',
        replayText: replay,
        routes: [{ role: 'ask', providerId: askAssignment.providerId, model: askAssignment.model }]
      })
      try {
        // One recovery provider call, no persistence yet. The final
        // assistant + Looplink consume + event success land in ONE
        // atomic transaction below — either all or none.
        const produced = await this.deps.completion.generateRecoveryTextOnly(
          { workspaceId: parsed.workspaceId, sessionId: built.targetSession.id },
          { providerId: askAssignment.providerId, model: askAssignment.model },
          { excludeDuplicateText: replay }
        )
        const looplinkId = produced.looplinkId ?? built.handoffId
        const now = this.now()
        this.deps.recoveryStore.completeAskSuccess(
          { eventId: built.event.id, looplinkId, targetSessionId: built.targetSession.id, content: produced.text, now }
        )
        const updated = this.deps.recoveryStore.findEventById(built.event.id)
        const finalRoutes = this.deps.recoveryStore.listRoutes(built.event.id)
        if (updated === undefined) {
          throw primaryError
        }
        const targetMessage = this.deps.sessions.findMessageById(updated.targetAssistantMessageId ?? -1)
        const targetSession = this.requireSession(parsed.workspaceId, built.targetSession.id)
        if (targetMessage === undefined) {
          throw primaryError
        }
        return {
          kind: 'recovered',
          targetSession,
          recoveryEvent: toRecoveryEvent(updated, finalRoutes),
          assistantMessage: {
            id: targetMessage.id,
            sessionId: targetMessage.sessionId,
            role: targetMessage.role,
            content: targetMessage.content,
            createdAt: targetMessage.createdAt,
            context: []
          }
        }
      } catch (recoveryError) {
        // Recovery provider/model failure: event failed, Looplink
        // stays pending, no assistant, no second target, no retry.
        // Distinguish provider failure from event-write noise: only
        // mark failed when the recovery attempt itself threw.
        try {
          this.deps.recoveryStore.markFailed(built.event.id, this.now())
        } catch {
          // Best effort.
        }
        void recoveryError
        const failed = this.deps.recoveryStore.findEventById(built.event.id)
        if (failed === undefined) {
          throw primaryError
        }
        const routes = this.deps.recoveryStore.listRoutes(built.event.id)
        const target = this.requireSession(parsed.workspaceId, built.targetSession.id)
        // Surface the recovery outcome as a handoff to the failed
        // target: UI shows "Recovery attempt failed" with the target.
        // Throw the original provider-safe shape? The coordinator
        // returns the failed event so the renderer can offer the
        // target without fabricating a second handoff.
        void target
        void routes
        // Re-fetch for the caller-visible failed state.
        const failedEvent = this.deps.recoveryStore.findEventById(built.event.id)
        if (failedEvent === undefined) {
          throw primaryError
        }
        // Return handoff-shaped failed state: the caller distinguishes
        // via event status failed. No additional provider call.
        return {
          kind: 'recovery_handoff',
          targetSession: built.targetSession,
          recoveryEvent: toRecoveryEvent(failedEvent, this.deps.recoveryStore.listRoutes(built.event.id)),
          failureCategory
        }
      }
    }
  }

  /** Work with single-hop whole-restart recovery. */
  async work(payload: unknown): Promise<WorkRecoveryResult> {
    if (this.deps.brain === undefined) {
      throw new InvalidRecoveryRequestError('work recovery is unavailable')
    }
    const brain = this.deps.brain
    const parsed = this.parseScope(payload)
    let sourceMessageId: number | null = null
    let sourceText: string | null = null
    try {
      const found = this.latestUserMessage(parsed.sessionId)
      if (found !== null) {
        sourceMessageId = found.id
        sourceText = found.content
      }
    } catch {
      sourceMessageId = null
    }
    try {
      const result = await brain.runBrain(payload)
      return { kind: 'completed', result }
    } catch (primaryError) {
      // Stage 23: tool-interactive Work never auto-recovers. A provider
      // failure after the first Worker tool request fails normally with
      // no Looplink target — replaying interactive approval/tool state
      // would require a larger continuation protocol.
      if (primaryError instanceof ToolInteractiveError) {
        throw primaryError
      }
      const failureCategory = failureCategoryFor(primaryError)
      const config = this.safeConfig()
      const isTarget = this.isRecoveryTarget(parsed.sessionId)
      const existing =
        sourceMessageId === null
          ? undefined
          : this.deps.recoveryStore.findEventBySource(parsed.sessionId, sourceMessageId, 'work')
      if (existing !== undefined) {
        const routes = this.deps.recoveryStore.listRoutes(existing.id)
        const target = this.requireSession(parsed.workspaceId, existing.targetSessionId)
        return {
          kind: 'recovery_handoff',
          targetSession: target,
          recoveryEvent: toRecoveryEvent(existing, routes),
          failureCategory: existing.failureCategory
        }
      }
      const decision = decideRecovery({
        mode: config.mode,
        failureCategory,
        isRecoveryTarget: isTarget,
        existingEvent: false
      })
      if (decision === 'none' || failureCategory === null || sourceMessageId === null || sourceText === null) {
        throw primaryError
      }
      if (decision === 'handoff') {
        const built = await this.createHandoffTarget({
          workspaceId: parsed.workspaceId,
          sourceSessionId: parsed.sessionId,
          sourceMessageId,
          operation: 'work',
          failureCategory,
          policyMode: 'handoff',
          replayText: null,
          routes: []
        })
        return {
          kind: 'recovery_handoff',
          targetSession: built.targetSession,
          recoveryEvent: built.event,
          failureCategory
        }
      }
      const brainAssignment = config.brain
      const workerAssignment = config.worker
      if (brainAssignment === null || workerAssignment === null) {
        throw primaryError
      }
      const replay = validateUserMessageContent(sourceText)
      const built = await this.createHandoffTarget({
        workspaceId: parsed.workspaceId,
        sourceSessionId: parsed.sessionId,
        sourceMessageId,
        operation: 'work',
        failureCategory,
        policyMode: 'auto_once',
        replayText: replay,
        routes: [
          { role: 'brain', providerId: brainAssignment.providerId, model: brainAssignment.model },
          { role: 'worker', providerId: workerAssignment.providerId, model: workerAssignment.model }
        ]
      })
      try {
        // Whole-work restart: max 3 recovery provider calls with step
        // audit persisted, but WITHOUT final completion. The final
        // assistant + run completion + Looplink consume + event success
        // land in ONE atomic transaction below.
        const produced = await brain.runBrainRecoveryTextOnly(
          { workspaceId: parsed.workspaceId, sessionId: built.targetSession.id },
          {
            brain: { providerId: brainAssignment.providerId, model: brainAssignment.model },
            worker: { providerId: workerAssignment.providerId, model: workerAssignment.model }
          },
          { excludeDuplicateText: replay }
        )
        const looplinkId = produced.looplinkId ?? built.handoffId
        const now = this.now()
        this.deps.recoveryStore.completeWorkSuccess({
          eventId: built.event.id,
          looplinkId,
          targetSessionId: built.targetSession.id,
          targetRunId: produced.runId,
          content: produced.finalText,
          action: produced.action,
          planSummary: produced.planSummary,
          now
        })
        const updated = this.deps.recoveryStore.findEventById(built.event.id)
        if (updated === undefined) {
          throw primaryError
        }
        const targetMessage = this.deps.sessions.findMessageById(updated.targetAssistantMessageId ?? -1)
        if (targetMessage === undefined) {
          throw primaryError
        }
        const targetSession = this.requireSession(parsed.workspaceId, built.targetSession.id)
        // Re-assemble the completed run for the caller (audit already
        // persisted with route_key=recovery).
        const completedRun = await brain.getRun({ runId: produced.runId })
        return {
          kind: 'recovered',
          targetSession,
          recoveryEvent: toRecoveryEvent(updated, this.deps.recoveryStore.listRoutes(built.event.id)),
          run: completedRun,
          assistantMessage: {
            id: targetMessage.id,
            sessionId: targetMessage.sessionId,
            role: targetMessage.role,
            content: targetMessage.content,
            createdAt: targetMessage.createdAt,
            context: []
          }
        }
      } catch {
        try {
          this.deps.recoveryStore.markFailed(built.event.id, this.now())
        } catch {
          // Best effort.
        }
        const failedEvent = this.deps.recoveryStore.findEventById(built.event.id)
        if (failedEvent === undefined) {
          throw primaryError
        }
        return {
          kind: 'recovery_handoff',
          targetSession: built.targetSession,
          recoveryEvent: toRecoveryEvent(failedEvent, this.deps.recoveryStore.listRoutes(built.event.id)),
          failureCategory
        }
      }
    }
  }

  private parseScope(payload: unknown): { workspaceId: number; sessionId: number } {
    if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
      throw new InvalidRecoveryRequestError('recovery request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, sessionId } = record
    if (!isValidId(workspaceId) || !isValidId(sessionId)) {
      throw new InvalidRecoveryRequestError('session reference is invalid')
    }
    return { workspaceId, sessionId }
  }

  private latestUserMessage(sessionId: number): { id: number; content: string } | null {
    const latest = this.deps.sessions.listMessagesNewestFirst(sessionId, 1, null)[0]
    if (latest === undefined || latest.role !== 'user') {
      return null
    }
    return { id: latest.id, content: latest.content }
  }

  private safeConfig(): RecoveryConfig {
    try {
      return this.deps.recoveryService.ensureConfig()
    } catch {
      return { mode: 'off', ask: null, brain: null, worker: null }
    }
  }

  private isRecoveryTarget(sessionId: number): boolean {
    return this.deps.recoveryStore.findEventByTarget(sessionId) !== undefined
  }

  private requireSession(workspaceId: number, sessionId: number): CodingSession {
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
    return toPublicSession(session)
  }

  private async createHandoffTarget(input: {
    workspaceId: number
    sourceSessionId: number
    sourceMessageId: number
    operation: RecoveryOperation
    failureCategory: string
    policyMode: string
    replayText: string | null
    routes: readonly { role: string; providerId: string; model: string }[]
  }): Promise<{ targetSession: CodingSession; event: RecoveryEvent; handoffId: number }> {
    const snapshot = await this.deps.looplinkService.buildRecoverySnapshot(input.workspaceId, input.sourceSessionId)
    const serialized = serializeLooplinkPayload(snapshot.payload)
    const payloadBytes = byteLengthOf(serialized)
    if (payloadBytes > MAX_LOOPLINK_PAYLOAD_BYTES) {
      throw new InvalidRecoveryRequestError('continuity snapshot is too large')
    }
    const now = this.now()
    const created = this.deps.recoveryStore.createTargetAggregate({
      workspaceId: input.workspaceId,
      sourceSessionId: input.sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      operation: input.operation,
      failureCategory: input.failureCategory,
      policyMode: input.policyMode,
      status: input.replayText === null ? 'handoff_ready' : 'running',
      attemptCount: input.replayText === null ? 0 : 1,
      targetTitle: deriveRecoveryTitle(snapshot.sourceTitle),
      sourceRunId: snapshot.sourceRunId,
      payload: serialized,
      payloadBytes,
      payloadHash: hashLooplinkPayload(serialized),
      omittedMessageCount: snapshot.payload.omissions.messageCount,
      omittedContextCount: snapshot.payload.omissions.contextCount,
      workerResultOmitted: snapshot.payload.omissions.workerResultOmitted,
      omittedChangeCount: snapshot.payload.omissions.changeCount,
      replayText: input.replayText,
      routes: input.routes,
      now
    })
    const target = this.deps.sessions.findSessionById(created.targetSessionId)
    const event = this.deps.recoveryStore.findEventById(created.eventId)
    if (target === undefined || event === undefined) {
      throw new InvalidRecoveryRequestError('recovery target could not be completed')
    }
    return {
      targetSession: toPublicSession(target),
      event: toRecoveryEvent(event, this.deps.recoveryStore.listRoutes(created.eventId)),
      handoffId: created.handoffId
    }
  }

  private markAskSucceeded(eventId: number, assistantMessageId: number): void {
    try {
      this.deps.recoveryStore.markAskSucceeded(eventId, assistantMessageId, this.now())
    } catch {
      // Best effort.
    }
  }

  private markWorkSucceeded(eventId: number, assistantMessageId: number, runId: number): void {
    try {
      this.deps.recoveryStore.markWorkSucceeded(eventId, assistantMessageId, runId, this.now())
    } catch {
      // Best effort.
    }
  }

  /** Test hook: exposes the legacy mark helpers for atomicity suites. */
  markAskSucceededForTest(eventId: number, assistantMessageId: number): void {
    this.markAskSucceeded(eventId, assistantMessageId)
  }

  markWorkSucceededForTest(eventId: number, assistantMessageId: number, runId: number): void {
    this.markWorkSucceeded(eventId, assistantMessageId, runId)
  }
}
