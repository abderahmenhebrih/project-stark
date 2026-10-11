import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { LocalProfile } from '../../../shared/profile/types'
import type { BrandStyleId } from '../../../shared/settings/types'
import type { Workspace, WorkspaceApi } from '../../../shared/workspace/types'
import { productionEntitlements } from '../features/billing/entitlements'
import { isDevelopmentBuild } from '../features/styles/style-assets'
import { resolveDevStyleUnlock } from '../features/styles/style-registry'
import { getProfileApi, getSettingsApi, getWorkspaceApi } from '../lib/stark-api'
import { AppContext, type AppContextValue, type BrandStyleSlice, type WorkspaceSlice } from './app-context'
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
 * Styles unlocked in production today (Free only; paid unlocks arrive
 * with Billing). The dev preview flag is consulted only through the
 * real build flag, which is statically `false` in packaged builds.
 */
function productionUnlockedStyles(): readonly BrandStyleId[] {
  const devUnlock = resolveDevStyleUnlock({ dev: isDevelopmentBuild() })
  if (devUnlock !== null) {
    return devUnlock
  }
  return productionEntitlements().unlockedStyles
}

/**
 * Minimal application state owner: local profile plus boot status, the
 * workspace slice, and the global brand-style slice. Style applies via
 * a document attribute (no reload, no state loss) and persists through
 * the existing main-owned settings store.
 */
export function AppProvider({ children }: AppProviderProps): ReactElement {
  const bridgeAvailable = getProfileApi() !== undefined
  const [profile, setProfile] = useState<LocalProfile | null>(null)
  const [loading, setLoading] = useState(bridgeAvailable)
  const [loadError, setLoadError] = useState(!bridgeAvailable)
  const [attempt, setAttempt] = useState(0)

  const [brandStyleId, setBrandStyleId] = useState<BrandStyleId>('free')
  const unlockedStyles = useMemo<readonly BrandStyleId[]>(() => productionUnlockedStyles(), [])

  // Restore the persisted style once; fall back to the highest entitled
  // style when the stored value is no longer unlocked. Bounded, fail-safe.
  useEffect(() => {
    const api = getSettingsApi()
    if (api === undefined) {
      return
    }
    let cancelled = false
    api
      .get()
      .then((settings) => {
        if (!cancelled) {
          const restored = settings.brandStyle
          const unlocked =
            resolveDevStyleUnlock({ dev: isDevelopmentBuild() }) ?? productionEntitlements().unlockedStyles
          setBrandStyleId(unlocked.includes(restored) ? restored : 'free')
        }
      })
      .catch(() => {
        // Best effort: Free stays applied when preferences are unreadable.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Whole-app brand presentation. Attribute-only: no reload, no unmount,
  // no session/editor/terminal state loss.
  useEffect(() => {
    try {
      document.documentElement.dataset['starkStyle'] = brandStyleId
    } catch {
      // Non-DOM test runtimes: style state still resolves; no crash.
    }
  }, [brandStyleId])

  const setBrandStyle = useCallback(
    async (style: BrandStyleId): Promise<void> => {
      if (!unlockedStyles.includes(style)) {
        return
      }
      const previous = brandStyleId
      setBrandStyleId(style)
      const api = getSettingsApi()
      if (api === undefined) {
        return
      }
      try {
        await api.update({ brandStyle: style })
      } catch {
        setBrandStyleId(previous)
      }
    },
    [brandStyleId, unlockedStyles]
  )

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

  const brandStyle = useMemo<BrandStyleSlice>(
    () => ({ style: brandStyleId, unlocked: unlockedStyles, setStyle: setBrandStyle }),
    [brandStyleId, unlockedStyles, setBrandStyle]
  )

  const value = useMemo<AppContextValue>(
    () => ({
      boot: resolveBootState({ loading, profile, loadError }),
      profile,
      completeOnboarding,
      refreshProfile,
      retryBoot,
      workspace,
      brandStyle
    }),
    [loading, profile, loadError, completeOnboarding, refreshProfile, retryBoot, workspace, brandStyle]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
