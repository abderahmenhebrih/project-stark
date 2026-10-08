import { IPC_CHANNELS } from '../../shared/constants'
import type { RecoveryConfig, RecoveryEvent } from '../../shared/recovery/types'
import type { RecoveryService } from '../recovery/recovery-service'
import type { RecoveryRepository } from '../recovery/recovery-repository'
import { toPublicRecoveryError } from '../recovery/recovery-errors'
import { InvalidRecoveryRequestError } from '../recovery/recovery-errors'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import { SessionNotFoundError, SessionWorkspaceMismatchError } from '../sessions/errors'
import type { IpcBinding } from './binding'

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

function toPublicEvent(
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
    operation: stored.operation as RecoveryEvent['operation'],
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

/**
 * Recovery IPC bindings (Stage 21): exactly five channels — read and
 * save the safe configuration plus read-only event lookups and
 * handoff_ready dismissal. No retry-now, no route-now, no arbitrary
 * provider, no failure-category injection. Automatic recovery is
 * driven only by real typed provider failure in main.
 */
export function createRecoveryBindings(
  service: RecoveryService,
  store: RecoveryRepository,
  workspaces: WorkspaceRepository,
  sessions: CodingSessionRepository,
  now: () => number = Date.now
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.recoveryGetConfig,
      invoke: (): Promise<RecoveryConfig | null> =>
        Promise.resolve()
          .then(() => service.getConfig())
          .catch((error: unknown) => {
            throw toPublicRecoveryError('get', error)
          })
    },
    {
      channel: IPC_CHANNELS.recoveryUpdateConfig,
      invoke: (payload): Promise<RecoveryConfig> =>
        Promise.resolve()
          .then(() => service.updateConfig(payload))
          .catch((error: unknown) => {
            throw toPublicRecoveryError('update', error)
          })
    },
    {
      channel: IPC_CHANNELS.recoveryGetForSource,
      invoke: (payload): Promise<RecoveryEvent | null> =>
        Promise.resolve()
          .then(() => {
            if (!hasStrictShape(payload, ['workspaceId', 'sessionId', 'messageId', 'operation'])) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            const record = payload as Record<string, unknown>
            const { workspaceId, sessionId, messageId, operation } = record
            if (!isValidId(workspaceId) || !isValidId(sessionId) || !isValidId(messageId)) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            if (operation !== 'ask' && operation !== 'work') {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            if (workspaces.findById(workspaceId) === undefined) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            const session = sessions.findSessionById(sessionId)
            if (session === undefined) {
              throw new SessionNotFoundError()
            }
            if (session.workspaceId !== workspaceId) {
              throw new SessionWorkspaceMismatchError()
            }
            const found = store.findEventBySource(sessionId, messageId, operation as string)
            if (found === undefined) {
              return null
            }
            return toPublicEvent(found, store.listRoutes(found.id))
          })
          .catch((error: unknown) => {
            throw toPublicRecoveryError('lookup', error)
          })
    },
    {
      channel: IPC_CHANNELS.recoveryGetForTarget,
      invoke: (payload): Promise<RecoveryEvent | null> =>
        Promise.resolve()
          .then(() => {
            if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            const record = payload as Record<string, unknown>
            const { workspaceId, sessionId } = record
            if (!isValidId(workspaceId) || !isValidId(sessionId)) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            if (workspaces.findById(workspaceId) === undefined) {
              throw new InvalidRecoveryRequestError('recovery lookup is invalid')
            }
            const session = sessions.findSessionById(sessionId)
            if (session === undefined) {
              throw new SessionNotFoundError()
            }
            if (session.workspaceId !== workspaceId) {
              throw new SessionWorkspaceMismatchError()
            }
            const found = store.findEventByTarget(sessionId)
            if (found === undefined) {
              return null
            }
            return toPublicEvent(found, store.listRoutes(found.id))
          })
          .catch((error: unknown) => {
            throw toPublicRecoveryError('lookup', error)
          })
    },
    {
      channel: IPC_CHANNELS.recoveryDismiss,
      invoke: (payload): Promise<RecoveryEvent> =>
        Promise.resolve()
          .then(() => {
            if (!hasStrictShape(payload, ['workspaceId', 'sessionId'])) {
              throw new InvalidRecoveryRequestError('recovery dismiss is invalid')
            }
            const record = payload as Record<string, unknown>
            const { workspaceId, sessionId } = record
            if (!isValidId(workspaceId) || !isValidId(sessionId)) {
              throw new InvalidRecoveryRequestError('recovery dismiss is invalid')
            }
            const session = sessions.findSessionById(sessionId)
            if (session === undefined) {
              throw new SessionNotFoundError()
            }
            if (session.workspaceId !== workspaceId) {
              throw new SessionWorkspaceMismatchError()
            }
            const found = store.findEventByTarget(sessionId)
            if (found === undefined || found.status !== 'handoff_ready') {
              throw new InvalidRecoveryRequestError('recovery is not dismissible')
            }
            store.dismissHandoffReady(found.id, found.looplinkHandoffId, now())
            const updated = store.findEventById(found.id)
            if (updated === undefined) {
              throw new InvalidRecoveryRequestError('recovery is not dismissible')
            }
            return toPublicEvent(updated, store.listRoutes(updated.id))
          })
          .catch((error: unknown) => {
            throw toPublicRecoveryError('dismiss', error)
          })
    }
  ]
}
