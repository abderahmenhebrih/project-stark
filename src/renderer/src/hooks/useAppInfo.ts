import { useEffect, useState } from 'react'
import { APP_NAME } from '../../../shared/constants'
import type { AppInfo } from '../../../shared/types'
import { getStarkApi } from '../lib/stark-api'

/** Fallback metadata used when the preload bridge is unavailable. */
const FALLBACK_APP_INFO: AppInfo = {
  name: APP_NAME,
  version: 'dev',
  platform: 'browser',
  electron: 'n/a',
  chrome: 'n/a',
  node: 'n/a'
}

interface AppInfoState {
  readonly appInfo: AppInfo | null
}

/**
 * Loads read-only application metadata from the main process
 * through the secure preload bridge. Never touches Node APIs.
 */
export function useAppInfo(): AppInfoState {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(() =>
    getStarkApi() === undefined ? FALLBACK_APP_INFO : null
  )

  useEffect(() => {
    const api = getStarkApi()

    if (api === undefined) {
      return
    }

    let cancelled = false

    api.getAppInfo().then(
      (info) => {
        if (!cancelled) {
          setAppInfo(info)
        }
      },
      () => {
        if (!cancelled) {
          setAppInfo(FALLBACK_APP_INFO)
        }
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  return { appInfo }
}
