import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { LocalProfile } from '../../../shared/profile/types'
import type { Workspace, WorkspaceApi } from '../../../shared/workspace/types'
import { getProfileApi, getWorkspaceApi } from '../lib/stark-api'
import { AppContext, type AppContextValue, type WorkspaceSlice } from './app-context'
import { resolveBootState } from './boot-state'

interface AppProviderProps {
  readonly children: ReactNode
}

interface WorkspaceSnapshot {
  readonly current: Workspace | null
  readonly recent: readonly Workspace[]
}

/** Single consistent read of current + recent workspaces. */
async function fetchWorkspaces(api: WorkspaceApi): Promise<WorkspaceSnapshot> {
  const [current, recent] = await Promise.all([api.getCurrent(), api.listRecent()])
  return { current, recent }
}

function toWorkspaceMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * Minimal application state owner: local profile plus boot status, plus
 * the workspace slice (current/recent workspaces and the actions that
 * change them). Workspace state loads once the profile is known and
 * refreshes after every choose/open — no reload, no external store.
 */
export function AppProvider({ children }: AppProviderProps): ReactElement {
  const bridgeAvailable = getProfileApi() !== undefined
  const [profile, setProfile] = useState<LocalProfile | null>(null)
  const [loading, setLoading] = useState(bridgeAvailable)
  const [loadError, setLoadError] = useState(!bridgeAvailable)
  const [attempt, setAttempt] = useState(0)

  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null)
  const [recentWorkspaces, setRecentWorkspaces] = useState<readonly Workspace[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(true)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [openingId, setOpeningId] = useState<number | null>(null)

  useEffect(() => {
    if (!bridgeAvailable) {
      return
    }
    let cancelled = false
    const api = getProfileApi()
    if (api === undefined) {
      return
    }
    api.get().then(
      (result) => {
        if (!cancelled) {
          setProfile(result)
          setLoading(false)
        }
      },
      () => {
        if (!cancelled) {
          setLoadError(true)
          setLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [attempt, bridgeAvailable])

  useEffect(() => {
    if (profile === null || !bridgeAvailable) {
      return
    }
    const api = getWorkspaceApi()
    if (api === undefined) {
      return
    }
    let cancelled = false
    fetchWorkspaces(api).then(
      (snapshot) => {
        if (!cancelled) {
          setCurrentWorkspace(snapshot.current)
          setRecentWorkspaces(snapshot.recent)
          setWorkspaceError(null)
          setWorkspaceLoading(false)
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setWorkspaceError(toWorkspaceMessage(error, 'We couldn’t load your workspaces.'))
          setWorkspaceLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [profile, bridgeAvailable])

  const completeOnboarding = useCallback(async (displayName: string): Promise<void> => {
    const api = getProfileApi()
    if (api === undefined) {
      throw new Error('[stark] profile API unavailable')
    }
    const saved = await api.setDisplayName(displayName)
    setProfile(saved)
  }, [])

  const refreshProfile = useCallback(async (): Promise<void> => {
    const api = getProfileApi()
    if (api === undefined) {
      return
    }
    try {
      setProfile(await api.get())
    } catch {
      // Best effort: the editor keeps its current value on failure.
    }
  }, [])

  const retryBoot = useCallback(() => {
    setLoading(true)
    setLoadError(false)
    setAttempt((count) => count + 1)
  }, [])

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    const api = getWorkspaceApi()
    if (api === undefined) {
      setWorkspaceError('We couldn’t load your workspaces.')
      setWorkspaceLoading(false)
      return
    }
    setWorkspaceLoading(true)
    setWorkspaceError(null)
    try {
      const snapshot = await fetchWorkspaces(api)
      setCurrentWorkspace(snapshot.current)
      setRecentWorkspaces(snapshot.recent)
    } catch (error) {
      setWorkspaceError(toWorkspaceMessage(error, 'We couldn’t load your workspaces.'))
    } finally {
      setWorkspaceLoading(false)
    }
  }, [])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    if (choosing) {
      return
    }
    const api = getWorkspaceApi()
    if (api === undefined) {
      setWorkspaceError('We couldn’t open that project folder.')
      return
    }
    setChoosing(true)
    setWorkspaceError(null)
    try {
      const result = await api.chooseDirectory()
      if (!result.canceled) {
        const snapshot = await fetchWorkspaces(api)
        setCurrentWorkspace(snapshot.current)
        setRecentWorkspaces(snapshot.recent)
      }
    } catch (error) {
      setWorkspaceError(toWorkspaceMessage(error, 'We couldn’t open that project folder.'))
    } finally {
      setChoosing(false)
    }
  }, [choosing])

  const openWorkspace = useCallback(
    async (workspaceId: number): Promise<void> => {
      if (openingId !== null) {
        return
      }
      const api = getWorkspaceApi()
      if (api === undefined) {
        setWorkspaceError('We couldn’t open that project folder.')
        return
      }
      setOpeningId(workspaceId)
      setWorkspaceError(null)
      try {
        await api.open(workspaceId)
        const snapshot = await fetchWorkspaces(api)
        setCurrentWorkspace(snapshot.current)
        setRecentWorkspaces(snapshot.recent)
      } catch (error) {
        setWorkspaceError(toWorkspaceMessage(error, 'We couldn’t open that project folder.'))
      } finally {
        setOpeningId(null)
      }
    },
    [openingId]
  )

  const workspace = useMemo<WorkspaceSlice>(
    () => ({
      current: currentWorkspace,
      recent: recentWorkspaces,
      loading: workspaceLoading,
      error: workspaceError,
      choosing,
      openingId,
      chooseWorkspace,
      openWorkspace,
      refreshWorkspaces
    }),
    [
      currentWorkspace,
      recentWorkspaces,
      workspaceLoading,
      workspaceError,
      choosing,
      openingId,
      chooseWorkspace,
      openWorkspace,
      refreshWorkspaces
    ]
  )

  const value = useMemo<AppContextValue>(
    () => ({
      boot: resolveBootState({ loading, profile, loadError }),
      profile,
      completeOnboarding,
      refreshProfile,
      retryBoot,
      workspace
    }),
    [loading, profile, loadError, completeOnboarding, refreshProfile, retryBoot, workspace]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
