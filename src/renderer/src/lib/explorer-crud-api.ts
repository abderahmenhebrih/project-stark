import type { WorkspaceCrudResult } from '../../../shared/workspace-files/types'
import { getStarkApi } from './stark-api'

function unavailable(action: string): Promise<never> {
  return Promise.reject(new Error(`We couldn’t ${action}.`))
}

/**
 * Typed direct-human file-operation callers (Explorer CRUD). Explicit
 * user actions only — create file/folder, leaf-name change, move to
 * Trash. These never create AI change transactions: this module
 * imports no changes bridge and offers no change-review path.
 */
export function createExplorerFile(workspaceId: number, parentPath: string, name: string): Promise<WorkspaceCrudResult> {
  const api = getStarkApi()?.workspace.files.createTextFile
  if (api === undefined) {
    return unavailable('create this file')
  }
  return api({ workspaceId, parentPath, name })
}

export function createExplorerFolder(workspaceId: number, parentPath: string, name: string): Promise<WorkspaceCrudResult> {
  const api = getStarkApi()?.workspace.files.createDirectory
  if (api === undefined) {
    return unavailable('create this folder')
  }
  return api({ workspaceId, parentPath, name })
}

export function renameExplorerEntry(workspaceId: number, relativePath: string, newName: string): Promise<WorkspaceCrudResult> {
  const api = getStarkApi()?.workspace.files.setEntryName
  if (api === undefined) {
    return unavailable('rename this item')
  }
  return api({ workspaceId, relativePath, newName })
}

export function trashExplorerEntry(workspaceId: number, relativePath: string): Promise<WorkspaceCrudResult> {
  const api = getStarkApi()?.workspace.files.moveToTrash
  if (api === undefined) {
    return unavailable('move this to Trash')
  }
  return api({ workspaceId, relativePath })
}

/** Safe display copy for CRUD failures (main already sanitizes). */
export function crudErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}
