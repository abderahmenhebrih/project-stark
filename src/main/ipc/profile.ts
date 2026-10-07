import { IPC_CHANNELS } from '../../shared/constants'
import type { LocalProfile } from '../../shared/profile/types'
import { toPublicError, type ProfileOperation } from '../profile/errors'
import type { ProfileService } from '../profile/profile-service'
import type { IpcBinding } from './binding'

/**
 * Profile IPC bindings: the complete, enumerable table of profile
 * channels and their handlers. Binding data (not registration) lives
 * here so tests can assert exactly which channels exist without an
 * Electron runtime. Registration through handleSecureIpc — which
 * supplies the invoke payload per call — happens in ./index.ts.
 *
 * Deliberately no generic key access and no clear operation: the
 * renderer may only read the profile or set a validated display name.
 */

async function withPublicError<T>(operation: ProfileOperation, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw toPublicError(operation, error)
  }
}

export function createProfileBindings(service: ProfileService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.profileGet,
      invoke: (): Promise<LocalProfile | null> => withPublicError('get', () => service.getProfile())
    },
    {
      channel: IPC_CHANNELS.profileSetDisplayName,
      invoke: (payload): Promise<LocalProfile> =>
        withPublicError('set-display-name', () => service.setDisplayName(payload))
    }
  ]
}
