import { ChangeTransactionService } from '../change-transactions/change-transaction-service'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { KeyValueRepository } from '../database/repositories/key-value-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { ProfileService } from '../profile/profile-service'
import { SettingsService } from '../settings/settings-service'
import { WorkspaceFileWriteService } from '../workspace-files/workspace-file-write-service'
import { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import { WorkspaceSearchService } from '../workspace-search/workspace-search-service'
import { WorkspaceService } from '../workspace/workspace-service'

/**
 * Application composition root.
 *
 * All domain services are constructed here, explicitly, from already
 * initialized infrastructure — no hidden global mutable service state,
 * no dependency-injection framework. Add future domains (workspaces,
 * sessions, …) as additional explicit fields.
 */
export interface ApplicationServices {
  readonly settingsService: SettingsService
  readonly profileService: ProfileService
  readonly workspaceService: WorkspaceService
  readonly workspaceFilesService: WorkspaceFilesService
  readonly workspaceFileWriteService: WorkspaceFileWriteService
  readonly workspaceSearchService: WorkspaceSearchService
  readonly changeTransactionService: ChangeTransactionService
}

export interface ServiceDependencies {
  readonly keyValue: KeyValueRepository
  readonly workspaces: WorkspaceRepository
  readonly changeTransactions: ChangeTransactionRepository
}

export function createServices(deps: ServiceDependencies): ApplicationServices {
  // One shared writer: the Stage 8 mutation primitive used both directly
  // by IPC writes and indirectly by transaction accept/rollback.
  const fileWriteService = new WorkspaceFileWriteService(deps.workspaces)
  return {
    settingsService: new SettingsService(deps.keyValue),
    profileService: new ProfileService(deps.keyValue),
    workspaceService: new WorkspaceService(deps.workspaces),
    workspaceFilesService: new WorkspaceFilesService(deps.workspaces),
    workspaceFileWriteService: fileWriteService,
    workspaceSearchService: new WorkspaceSearchService(deps.workspaces),
    changeTransactionService: new ChangeTransactionService(
      deps.workspaces,
      deps.changeTransactions,
      fileWriteService
    )
  }
}
