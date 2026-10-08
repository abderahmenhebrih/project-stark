import { IPC_CHANNELS } from '../../shared/constants'
import type { WorkRecoveryResult } from '../../shared/ai/types'
import type { WorkerToolApproval } from '../../shared/worker-tools/types'
import type { WorkerToolRunner } from '../worker-tools/worker-tool-runner'
import { toPublicWorkerToolError } from '../worker-tools/worker-tool-errors'
import type { IpcBinding } from './binding'

/**
 * Worker-tool approval IPC (Stage 23): exactly three channels —
 * pending lookup plus approve/deny-and-resume. IDs only; main
 * derives run/tool/args. No tool name, args, capability, result, or
 * generic execute endpoint exists. Tool execution is reachable only
 * through internal Worker orchestration.
 */
export function createWorkerToolBindings(runner: WorkerToolRunner): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.workerToolsGetPendingApproval,
      invoke: (payload): Promise<WorkerToolApproval | null> =>
        Promise.resolve()
          .then(() => runner.getPendingApproval(payload))
          .catch((error: unknown) => {
            throw toPublicWorkerToolError('lookup', error)
          })
    },
    {
      channel: IPC_CHANNELS.workerToolsApproveAndResume,
      invoke: (payload): Promise<WorkRecoveryResult> =>
        Promise.resolve()
          .then(() => runner.approveAndResume(payload))
          .catch((error: unknown) => {
            throw toPublicWorkerToolError('approve', error)
          })
    },
    {
      channel: IPC_CHANNELS.workerToolsDenyAndResume,
      invoke: (payload): Promise<WorkRecoveryResult> =>
        Promise.resolve()
          .then(() => runner.denyAndResume(payload))
          .catch((error: unknown) => {
            throw toPublicWorkerToolError('approve', error)
          })
    }
  ]
}
