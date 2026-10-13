import { IPC_CHANNELS } from '../../shared/constants'
import type { AiCancelOperationResult, AiChangeSetProposalResult, AiFileChangeProposalResult, AskRecoveryResult } from '../../shared/ai/types'
import type { AiCodeProposalService } from '../ai/ai-code-proposal-service'
import type { AiCompletionService } from '../ai/ai-completion-service'
import type { AiMultiFileProposalService } from '../ai/ai-multi-file-proposal-service'
import type { AiOperationGuard } from '../ai/ai-operation-guard'
import type { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidProviderRequestError } from '../ai/errors'
import { SessionNotFoundError, SessionWorkspaceMismatchError, SessionWorkspaceUnavailableError } from '../sessions/errors'
import { toPublicChangeSetProposalError } from '../ai/ai-change-set-errors'
import { toPublicProposalError } from '../ai/ai-proposal-errors'
import { toPublicProviderError } from '../ai/errors'
import type { IpcBinding } from './binding'

/**
 * AI IPC bindings (Stage 14 + Stage 16 + Stage 17 + Stage 21): exactly
 * three invoke channels — assistant generation (with single-hop
 * recovery when a coordinator is present), single-file code
 * proposals, and grouped multi-file proposals. The renderer submits
 * workspace/session references only. Recovery returns a discriminated
 * result (completed / recovery_handoff / recovered) — never parsed
 * error strings. Proposals never recover.
 */
export function createAiBindings(
  completion: AiCompletionService,
  proposals?: AiCodeProposalService,
  changeSets?: AiMultiFileProposalService,
  recovery?: AiRecoveryCoordinator
): readonly IpcBinding[] {
  const bindings: IpcBinding[] = [
    {
      channel: IPC_CHANNELS.aiGenerateResponse,
      invoke: (payload): Promise<AskRecoveryResult> => {
        if (recovery !== undefined) {
          return recovery.ask(payload).catch((error: unknown) => {
            throw toPublicProviderError('generate', error)
          })
        }
        return completion
          .generateResponse(payload)
          .then((result) => ({ kind: 'completed', result }) as AskRecoveryResult)
          .catch((error: unknown) => {
            throw toPublicProviderError('generate', error)
          })
      }
    }
  ]
  if (proposals !== undefined) {
    bindings.push({
      channel: IPC_CHANNELS.aiProposeFileChange,
      invoke: (payload): Promise<AiFileChangeProposalResult> =>
        proposals.proposeFileChange(payload).catch((error: unknown) => {
          throw toPublicProposalError('propose', error)
        })
    })
  }
  if (changeSets !== undefined) {
    bindings.push({
      channel: IPC_CHANNELS.aiProposeChangeSet,
      invoke: (payload): Promise<AiChangeSetProposalResult> =>
        changeSets.proposeChangeSet(payload).catch((error: unknown) => {
          throw toPublicChangeSetProposalError('propose-set', error)
        })
    })
  }
  return bindings
}

/**
 * User-cancellation IPC binding: exactly one narrow channel. The
 * renderer submits a workspace/session reference only; main owns
 * cancellation authority through the shared operation guard plus the
 * parked-run cancellation path (a run parked awaiting tool approval
 * still counts as a logically active operation and MUST be
 * cancellable — guard release before parking never makes Cancel a
 * no-op). Session-scoped (never global), idempotent, and safe when
 * idle (`{ cancelled: false }` — never an error). Workspace/session
 * ownership is validated before touching the guard or any parked run
 * so one session can never cancel another's operation.
 */
export function createAiCancelBinding(
  guard: AiOperationGuard,
  workspaces: WorkspaceRepository,
  sessions: CodingSessionRepository,
  parked?: { cancelParkedWork: (payload: unknown) => { cancelled: boolean } }
): IpcBinding {
  return {
    channel: IPC_CHANNELS.aiCancelOperation,
    invoke: async (payload): Promise<AiCancelOperationResult> => {
      try {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new InvalidProviderRequestError('cancellation request is invalid')
        }
        const record = payload as Record<string, unknown>
        const { workspaceId, sessionId } = record
        if (
          typeof workspaceId !== 'number' ||
          !Number.isInteger(workspaceId) ||
          workspaceId <= 0 ||
          typeof sessionId !== 'number' ||
          !Number.isInteger(sessionId) ||
          sessionId <= 0
        ) {
          throw new InvalidProviderRequestError('cancellation request is invalid')
        }
        if (workspaces.findById(workspaceId) === undefined) {
          throw new SessionWorkspaceUnavailableError()
        }
        const session = sessions.findSessionById(sessionId)
        if (session === undefined) {
          throw new SessionNotFoundError()
        }
        if (session.workspaceId !== workspaceId) {
          throw new SessionWorkspaceMismatchError()
        }
        // Active in-flight operation first (aborts the signal).
        if (guard.requestCancel(sessionId)) {
          return { cancelled: true }
        }
        // Parked approval second: a waiting_for_approval run is still
        // logically active and MUST be cancellable. Transitions the
        // run/approval to terminal `cancelled` (never approval/denial,
        // never filesystem writes); the session is immediately reusable.
        if (parked !== undefined) {
          try {
            const outcome = parked.cancelParkedWork({ workspaceId, sessionId })
            if (outcome.cancelled) {
              return { cancelled: true }
            }
          } catch (error) {
            // Ownership errors stay rejections (wrong-session safety);
            // any other parked-cancel failure degrades to idle false so
            // Cancel never throws for a genuinely idle session.
            if (
              error instanceof SessionNotFoundError ||
              error instanceof SessionWorkspaceMismatchError ||
              error instanceof SessionWorkspaceUnavailableError
            ) {
              throw error
            }
          }
        }
        return { cancelled: false }
      } catch (error) {
        if (
          error instanceof SessionNotFoundError ||
          error instanceof SessionWorkspaceMismatchError ||
          error instanceof SessionWorkspaceUnavailableError
        ) {
          throw new Error(error.message, { cause: error })
        }
        throw toPublicProviderError('generate', error)
      }
    }
  }
}
