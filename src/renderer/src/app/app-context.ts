import { createContext, useContext } from 'react'
import type { LocalProfile } from '../../../shared/profile/types'
import type { Workspace } from '../../../shared/workspace/types'
import type { BootState } from './boot-state'

export interface WorkspaceSlice {
  readonly current: Workspace | null
  readonly recent: readonly Workspace[]
  readonly loading: boolean
  readonly error: string | null
  readonly choosing: boolean
  readonly openingId: number | null
  readonly chooseWorkspace: () => Promise<void>
  readonly openWorkspace: (workspaceId: number) => Promise<void>
  readonly refreshWorkspaces: () => Promise<void>
}

export interface AppContextValue {
  readonly boot: BootState
  readonly profile: LocalProfile | null
  readonly completeOnboarding: (displayName: string) => Promise<void>
  readonly retryBoot: () => void
  readonly workspace: WorkspaceSlice
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (value === null) {
    throw new Error('[stark] useApp must be used within AppProvider')
  }
  return value
}
