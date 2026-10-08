import type {
  DecideApprovalRequest,
  GetPendingApprovalRequest,
  WorkerToolApproval,
  WorkerToolsApi
} from '../../../shared/worker-tools/types'
import type { WorkRecoveryResult } from '../../../shared/ai/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the Worker-tools approval API.
 * Same Electron-only availability as the bridge itself.
 */
export function getWorkerToolsApi(): WorkerToolsApi | undefined {
  return getStarkApi()?.workerTools
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load the pending approval.'))
}

/**
 * Typed approval callers. Explicit approve/deny only — no polling,
 * no timers, no tool execution from the renderer. Main derives all
 * run/tool/argument state from IDs.
 */
export function getPendingWorkerApproval(request: GetPendingApprovalRequest): Promise<WorkerToolApproval | null> {
  const api = getWorkerToolsApi()?.getPendingApproval
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function approveWorkerApproval(request: DecideApprovalRequest): Promise<WorkRecoveryResult> {
  const api = getWorkerToolsApi()?.approveAndResume
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t resolve this approval.'))
  }
  return api(request)
}

export function denyWorkerApproval(request: DecideApprovalRequest): Promise<WorkRecoveryResult> {
  const api = getWorkerToolsApi()?.denyAndResume
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t resolve this approval.'))
  }
  return api(request)
}
