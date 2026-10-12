import { IPC_CHANNELS } from '../../shared/constants'
import type {
  DetectPreviewResult,
  HumanPreviewSummary,
  ProjectRuntimeSummary,
  StartHumanPreviewResult
} from '../../shared/project-runtime/types'
import type { ProjectRuntimeService } from '../project-runtime/project-runtime-service'
import { toPublicProjectRuntimeError } from '../project-runtime/project-runtime-errors'
import { InvalidWorkerToolRequestError } from '../worker-tools/worker-tool-errors'
import type { IpcBinding } from './binding'

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseWorkspaceScope(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidWorkerToolRequestError('runtime request is invalid')
  }
  const record = payload as Record<string, unknown>
  // Workspace only — nothing else may enter, not even a URL.
  if (Object.keys(record).length !== 1) {
    throw new InvalidWorkerToolRequestError('runtime request is invalid')
  }
  const workspaceId = record['workspaceId']
  if (!isValidId(workspaceId)) {
    throw new InvalidWorkerToolRequestError('workspace reference is invalid')
  }
  return workspaceId
}

function parseRuntimeRef(payload: unknown): { workspaceId: number; runtimeId: number } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidWorkerToolRequestError('runtime request is invalid')
  }
  const record = payload as Record<string, unknown>
  const { workspaceId, runtimeId } = record
  // IDs only — the service derives URLs, ownership, and liveness.
  // Program, args, ports, PIDs, and URLs can never enter here.
  if (Object.keys(record).length !== 2 || !isValidId(workspaceId) || !isValidId(runtimeId)) {
    throw new InvalidWorkerToolRequestError('runtime reference is invalid')
  }
  return { workspaceId, runtimeId }
}

/**
 * Project-runtime management IPC: five worker-runtime read/stop/
 * preview channels plus five human-preview channels (detect, get,
 * start, stop, restart). No spawn, no execute, no program/args/URL/PID
 * surface — worker starts route only through an approved Worker
 * runtime_start, and human starts derive the dev script main-side
 * from the workspace package.json (the renderer sends workspace ids
 * only). Stopping and preview are direct human actions needing no AI
 * approval.
 */
export function createRuntimeBindings(service: ProjectRuntimeService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.runtimesGetActive,
      invoke: (payload): Promise<ProjectRuntimeSummary | null> =>
        Promise.resolve()
          .then(() => service.getActiveSummary(parseWorkspaceScope(payload)))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('read', error)
          })
    },
    {
      channel: IPC_CHANNELS.runtimesListRecent,
      invoke: (payload): Promise<readonly ProjectRuntimeSummary[]> =>
        Promise.resolve()
          .then(() => service.listRecentSummaries(parseWorkspaceScope(payload)))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('read', error)
          })
    },
    {
      channel: IPC_CHANNELS.runtimesStop,
      invoke: (payload): Promise<ProjectRuntimeSummary> =>
        Promise.resolve()
          .then(() => {
            const ref = parseRuntimeRef(payload)
            return service.stopRuntime({ workspaceId: ref.workspaceId, runtimeId: ref.runtimeId, now: Date.now() })
          })
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('stop', error)
          })
    },
    {
      channel: IPC_CHANNELS.runtimesOpenPreview,
      invoke: (payload): Promise<ProjectRuntimeSummary> =>
        Promise.resolve()
          .then(() => {
            const ref = parseRuntimeRef(payload)
            return service.openPreview({ workspaceId: ref.workspaceId, runtimeId: ref.runtimeId })
          })
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('preview', error)
          })
    },
    {
      channel: IPC_CHANNELS.runtimesReloadPreview,
      invoke: (payload): Promise<ProjectRuntimeSummary> =>
        Promise.resolve()
          .then(() => {
            const ref = parseRuntimeRef(payload)
            return service.reloadPreview({ workspaceId: ref.workspaceId, runtimeId: ref.runtimeId })
          })
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('preview', error)
          })
    },
    {
      channel: IPC_CHANNELS.previewDetect,
      invoke: (payload): Promise<DetectPreviewResult> =>
        Promise.resolve()
          .then(() => service.detectHumanPreview(parseWorkspaceScope(payload)))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('read', error)
          })
    },
    {
      channel: IPC_CHANNELS.previewGet,
      invoke: (payload): Promise<HumanPreviewSummary | null> =>
        Promise.resolve()
          .then(() => service.getHumanPreview(parseWorkspaceScope(payload)))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('read', error)
          })
    },
    {
      channel: IPC_CHANNELS.previewStart,
      invoke: (payload): Promise<StartHumanPreviewResult> =>
        Promise.resolve()
          .then(() => service.startHumanPreview({ workspaceId: parseWorkspaceScope(payload), now: Date.now() }))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('preview', error)
          })
    },
    {
      channel: IPC_CHANNELS.previewStop,
      invoke: (payload): Promise<HumanPreviewSummary | null> =>
        Promise.resolve()
          .then(() => service.stopHumanPreview({ workspaceId: parseWorkspaceScope(payload), now: Date.now() }))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('stop', error)
          })
    },
    {
      channel: IPC_CHANNELS.previewRestart,
      invoke: (payload): Promise<StartHumanPreviewResult> =>
        Promise.resolve()
          .then(() => service.restartHumanPreview({ workspaceId: parseWorkspaceScope(payload), now: Date.now() }))
          .catch((error: unknown) => {
            throw toPublicProjectRuntimeError('preview', error)
          })
    }
  ]
}
