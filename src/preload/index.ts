import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type { AppInfo, StarkApi } from '../shared/types'

/**
 * Secure preload bridge.
 *
 * This is the ONLY code that runs with access to both the Electron API
 * and the renderer window. It exposes a minimal, typed `window.stark`
 * object and nothing else — no `ipcRenderer`, no `process`, no Node.js.
 */
const starkApi: StarkApi = {
  getAppInfo: (): Promise<AppInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>
}

contextBridge.exposeInMainWorld('stark', starkApi)
