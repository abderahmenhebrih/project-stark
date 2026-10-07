import type { IpcMainInvokeEvent } from 'electron'
import type { IpcChannel } from '../../shared/constants'

/**
 * A single IPC endpoint as pure data: fixed channel plus handler.
 * Handlers receive the invoke payload and, when registration supplies
 * it, the already-validated IPC event (needed by bindings that must act
 * as the validated sender, such as the native directory picker).
 * Registration through handleSecureIpc happens in ./index.ts.
 */
export interface IpcBinding {
  readonly channel: IpcChannel
  readonly invoke: (payload?: unknown, event?: IpcMainInvokeEvent) => Promise<unknown>
}
