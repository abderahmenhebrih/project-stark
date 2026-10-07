import { BrowserWindow, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ChooseWorkspaceResult, Workspace } from '../../shared/workspace/types'
import { toPublicError, WorkspaceError, type WorkspaceOperation } from '../workspace/errors'
import type { WorkspaceService } from '../workspace/workspace-service'
import type { IpcBinding } from './binding'

/**
 * Native directory picker boundary.
 *
 * Only this module (plus its tests) touches Electron's dialog. The
 * renderer never sends paths and never calls dialog: it invokes the
 * fixed choose-directory channel, the main process opens the OS picker
 * as the already-validated sender's window, and the picked path flows
 * into WorkspaceService for validation. Cancellation resolves to
 * undefined — never an error, never a workspace.
 */
export interface WorkspacePicker {
  pickDirectory(parentWindow: BrowserWindow | undefined): Promise<string | undefined>
}

/** Exact native dialog configuration. Pure — unit-tested as data. */
export function buildOpenDialogOptions(): {
  readonly title: string
  readonly buttonLabel: string
  readonly properties: readonly ['openDirectory']
} {
  return {
    title: 'Open project folder',
    buttonLabel: 'Open folder',
    properties: ['openDirectory']
  }
}

/** Production picker: single-directory OS dialog, no multi-selection. */
export const electronDirectoryPicker: WorkspacePicker = {
  async pickDirectory(parentWindow: BrowserWindow | undefined): Promise<string | undefined> {
    const options = buildOpenDialogOptions()
    let result: { canceled: boolean; filePaths: string[] }
    try {
      result =
        parentWindow === undefined
          ? await dialog.showOpenDialog({
              title: options.title,
              buttonLabel: options.buttonLabel,
              properties: [...options.properties]
            })
          : await dialog.showOpenDialog(parentWindow, {
              title: options.title,
              buttonLabel: options.buttonLabel,
              properties: [...options.properties]
            })
    } catch (error) {
      console.warn(
        `[STARK] native directory picker failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw new WorkspaceError('directory picker failed')
    }
    if (result.canceled || result.filePaths.length === 0) {
      return undefined
    }
    const first = result.filePaths[0]
    return typeof first === 'string' && first !== '' ? first : undefined
  }
}

async function withPublicError<T>(operation: WorkspaceOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicError(operation, error)
  }
}

/**
 * Workspace IPC bindings: get-current, list-recent, choose-directory,
 * open. No filesystem, dialog, or SQL channels — the picker above is
 * the only place new paths enter, and IDs resolve against storage.
 */
export function createWorkspaceBindings(
  service: WorkspaceService,
  picker: WorkspacePicker
): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.workspaceGetCurrent,
      invoke: (): Promise<Workspace | null> => withPublicError('get-current', () => service.getCurrentWorkspace())
    },
    {
      channel: IPC_CHANNELS.workspaceListRecent,
      invoke: (): Promise<Workspace[]> =>
        withPublicError('list-recent', () => service.listRecentWorkspaces())
    },
    {
      channel: IPC_CHANNELS.workspaceChooseDirectory,
      invoke: (_payload, event): Promise<ChooseWorkspaceResult> =>
        withPublicError('choose-directory', async () => {
          const parent =
            event === undefined ? undefined : (BrowserWindow.fromWebContents(event.sender) ?? undefined)
          const picked = await picker.pickDirectory(parent)
          if (picked === undefined) {
            return { canceled: true }
          }
          const workspace = await service.openDirectory(picked)
          return { canceled: false, workspace }
        })
    },
    {
      channel: IPC_CHANNELS.workspaceOpen,
      invoke: (payload): Promise<Workspace> =>
        withPublicError('open', () => service.openWorkspaceById(payload))
    }
  ]
}
