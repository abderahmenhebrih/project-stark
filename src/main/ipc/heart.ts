import { IPC_CHANNELS } from '../../shared/constants'
import type { HeartConfig } from '../../shared/heart/types'
import type { HeartService } from '../heart/heart-service'
import { toPublicHeartError } from '../heart/heart-errors'
import type { IpcBinding } from './binding'

/**
 * Heart IPC bindings (Stage 19): exactly two channels — read the
 * safe configuration and save a complete configuration. No routing
 * execution, no credential access, no model testing. Payloads are
 * opaque to this layer. Registration through handleSecureIpc happens
 * in ./index.ts.
 */
export function createHeartBindings(service: HeartService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.heartGet,
      invoke: (): Promise<HeartConfig | null> =>
        Promise.resolve()
          .then(() => service.getConfig())
          .catch((error: unknown) => {
            throw toPublicHeartError('get', error)
          }),
    },
    {
      channel: IPC_CHANNELS.heartUpdate,
      invoke: (payload): Promise<HeartConfig> =>
        Promise.resolve()
          .then(() => service.updateConfig(payload))
          .catch((error: unknown) => {
            throw toPublicHeartError('update', error)
          })
    }
  ]
}
