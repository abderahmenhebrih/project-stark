import { app } from 'electron'
import { APP_NAME } from '../../shared/constants'
import type { AppInfo } from '../../shared/types'

/**
 * Application metadata service.
 *
 * Lives in the main process. Renderers receive this data through the
 * `stark:get-app-info` IPC channel — never by touching Node APIs.
 */
export function getAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }
}
