import { IPC_CHANNELS } from '../../shared/constants'
import type {
  AiProviderState,
  ProviderConnectionResult,
  ProviderModel
} from '../../shared/providers/types'
import type { AiProviderService } from '../ai/ai-provider-service'
import { toPublicProviderError } from '../ai/errors'
import type { IpcBinding } from './binding'

/**
 * AI provider IPC bindings (Stage 14): exactly six invoke channels
 * (get-state, save-credential, clear-credential, test-connection,
 * list-models, set-model). No raw requests, no fetch, no base-URL or
 * header setters, no key getters, no decrypt channel. Payloads are
 * opaque to this layer — the service validates provider IDs, keys,
 * and model IDs at runtime. Registration through handleSecureIpc
 * happens in ./index.ts. No credential bytes ever cross these
 * channels in either direction.
 */
export function createProviderBindings(service: AiProviderService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.providersGetState,
      invoke: (payload): Promise<AiProviderState> =>
        service.getState(payload).catch((error: unknown) => {
          throw toPublicProviderError('state', error)
        })
    },
    {
      channel: IPC_CHANNELS.providersSaveCredential,
      invoke: (payload): Promise<AiProviderState> =>
        service.saveCredential(payload).catch((error: unknown) => {
          throw toPublicProviderError('save', error)
        })
    },
    {
      channel: IPC_CHANNELS.providersClearCredential,
      invoke: (payload): Promise<AiProviderState> =>
        service.clearCredential(payload).catch((error: unknown) => {
          throw toPublicProviderError('clear', error)
        })
    },
    {
      channel: IPC_CHANNELS.providersTestConnection,
      invoke: (payload): Promise<ProviderConnectionResult> =>
        service.testConnection(payload).catch((error: unknown) => {
          throw toPublicProviderError('test', error)
        })
    },
    {
      channel: IPC_CHANNELS.providersListModels,
      invoke: (payload): Promise<readonly ProviderModel[]> =>
        service.listModels(payload).catch((error: unknown) => {
          throw toPublicProviderError('models', error)
        })
    },
    {
      channel: IPC_CHANNELS.providersSetModel,
      invoke: (payload): Promise<AiProviderState> =>
        service.setModel(payload).catch((error: unknown) => {
          throw toPublicProviderError('set-model', error)
        })
    }
  ]
}
