import { IPC_CHANNELS } from '../../shared/constants'
import type { ExtensionSearchResult } from '../../shared/extension-registry/types'
import { toPublicExtensionRegistryError } from '../extension-registry/errors'
import type { ExtensionRegistryService } from '../extension-registry/extension-registry-service'
import type { IpcBinding } from './binding'

function readQuery(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw toPublicExtensionRegistryError(new Error('bad payload'))
  }
  const keys = Object.keys(payload)
  if (keys.length !== 1 || keys[0] !== 'query') {
    throw toPublicExtensionRegistryError(new Error('bad payload'))
  }
  const query = (payload as Record<string, unknown>)['query']
  if (typeof query !== 'string') {
    throw toPublicExtensionRegistryError(new Error('bad payload'))
  }
  return query
}

function requireEmpty(payload: unknown): void {
  if (payload === undefined) {
    return
  }
  if (typeof payload === 'object' && payload !== null && Object.keys(payload).length === 0) {
    return
  }
  throw toPublicExtensionRegistryError(new Error('bad payload'))
}

/**
 * Extension-catalog IPC bindings (display only): exactly two invoke
 * channels (search, list-featured). No URL parameter exists anywhere —
 * the service owns the fixed registry origin. No generic network
 * request, no HTTP proxy, no install/download/host surface. Payloads
 * are shape-validated here; the service re-validates query text.
 * Registration through handleSecureIpc happens in ./index.ts.
 */
export function createExtensionsBindings(service: ExtensionRegistryService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionsSearch,
      invoke: (payload): Promise<ExtensionSearchResult> =>
        Promise.resolve()
          .then(() => readQuery(payload))
          .then((query) => service.search(query))
          .catch((error: unknown) => {
            throw toPublicExtensionRegistryError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListFeatured,
      invoke: (payload): Promise<ExtensionSearchResult> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => service.listFeatured())
          .catch((error: unknown) => {
            throw toPublicExtensionRegistryError(error)
          })
    }
  ]
}
