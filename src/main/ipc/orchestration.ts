import { IPC_CHANNELS } from '../../shared/constants'
import type { WorkRecoveryResult } from '../../shared/ai/types'
import type { OrchestrationRun } from '../../shared/orchestration/types'
import type { AiBrainService } from '../ai/ai-brain-service'
import type { AiRecoveryCoordinator } from '../recovery/recovery-coordinator'
import type { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { toPublicBrainError } from '../ai/ai-brain-errors'
import { ToolInteractiveError, WorkerToolError, toPublicWorkerToolError } from '../worker-tools/worker-tool-errors'
import type { IpcBinding } from './binding'

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseScope(payload: unknown): { workspaceId: number; sessionId: number } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const record = payload as Record<string, unknown>
  const { workspaceId, sessionId } = record
  if (!isValidId(workspaceId) || !isValidId(sessionId)) {
    return null
  }
  return { workspaceId, sessionId }
}

/**
 * Orchestration IPC bindings (Stage 18 + Stage 21 + Stage 23):
 * exactly three channels — one Brain run plus two read-only
 * run-history operations. Tool-advertised sessions run through the
 * read-only Worker tool runner (with exact per-action approval);
 * other sessions keep single-hop Stage 21 recovery. Tool-interactive
 * failures never auto-recover. Results stay discriminated.
 */
export function createOrchestrationBindings(
  service: AiBrainService,
  recovery?: AiRecoveryCoordinator,
  runner?: WorkerToolRunner
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.aiRunBrain,
      invoke: async (payload): Promise<WorkRecoveryResult> => {
        if (runner !== undefined) {
          const scope = parseScope(payload)
          let advertised = false
          if (scope !== null) {
            try {
              advertised = runner.toolsAdvertised(scope.workspaceId, scope.sessionId)
            } catch {
              advertised = false
            }
          }
          if (advertised) {
            try {
              return await runner.runToolWork(payload)
            } catch (error) {
              if (error instanceof ToolInteractiveError) {
                throw toPublicBrainError('run', error)
              }
              if (error instanceof WorkerToolError) {
                throw toPublicWorkerToolError('run', error)
              }
              // Failure before any tool interaction: legacy Stage 21
              // recovery may still apply.
              if (recovery !== undefined) {
                return recovery.work(payload).catch((recoveryError: unknown) => {
                  throw toPublicBrainError('run', recoveryError)
                })
              }
              throw toPublicBrainError('run', error)
            }
          }
        }
        if (recovery !== undefined) {
          return recovery.work(payload).catch((error: unknown) => {
            throw toPublicBrainError('run', error)
          })
        }
        return service
          .runBrain(payload)
          .then((result) => ({ kind: 'completed', result }) as WorkRecoveryResult)
          .catch((error: unknown) => {
            throw toPublicBrainError('run', error)
          })
      }
    },
    {
      channel: IPC_CHANNELS.orchestrationGet,
      invoke: (payload): Promise<OrchestrationRun> =>
        service.getRun(payload).catch((error: unknown) => {
          throw toPublicBrainError('get', error)
        })
    },
    {
      channel: IPC_CHANNELS.orchestrationListRecent,
      invoke: (payload): Promise<readonly OrchestrationRun[]> =>
        service.listRecentRuns(payload).catch((error: unknown) => {
          throw toPublicBrainError('list-recent', error)
        })
    }
  ]
}
