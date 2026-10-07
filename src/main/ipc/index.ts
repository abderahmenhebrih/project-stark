import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { APP_NAME, IPC_CHANNELS, type IpcChannel } from '../../shared/constants'
import { RENDERER_DEV_URL } from '../security/app-urls'
import { getAppInfo } from '../services/app-info'
import { isTrustedRendererUrl } from './sender'

function senderUrlOf(event: IpcMainInvokeEvent): string | undefined {
  return event.senderFrame?.url ?? event.sender.getURL()
}

/**
 * Registers an IPC handler that first proves the caller is STARK's own
 * renderer (dev-server origin in development, packaged document in
 * production). Untrusted callers are rejected with an error, which
 * surfaces to the renderer as a rejected invoke promise.
 *
 * Every privileged handler must use this instead of ipcMain.handle.
 */
export function handleSecureIpc<TArgs extends unknown[], TReturn>(
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TReturn | Promise<TReturn>
): void {
  ipcMain.handle(channel, (event, ...args: TArgs) => {
    const trusted =
      !event.sender.isDestroyed() &&
      isTrustedRendererUrl(senderUrlOf(event), { devServerUrl: RENDERER_DEV_URL })
    if (!trusted) {
      console.warn(`[${APP_NAME}] rejected IPC '${channel}' from an untrusted sender`)
      throw new Error(`[stark] untrusted IPC sender for '${channel}'`)
    }
    return handler(event, ...args)
  })
}

/**
 * Registers every IPC handler exposed to renderers.
 *
 * Rules for this module:
 * - One handler per channel declared in shared/constants IPC_CHANNELS.
 * - Handlers delegate to services; no business logic lives here.
 * - Never expose filesystem, shell, or process spawning to the renderer.
 */
export function registerIpcHandlers(): void {
  handleSecureIpc(IPC_CHANNELS.getAppInfo, () => getAppInfo())
}
