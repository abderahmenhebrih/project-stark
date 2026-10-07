import { IPC_CHANNELS } from '../../shared/constants'
import type { StarkSettings } from '../../shared/settings/types'
import { toPublicError, type SettingsOperation } from '../settings/errors'
import type { SettingsService } from '../settings/settings-service'
import type { IpcBinding } from './binding'

/**
 * Settings IPC bindings: the complete, enumerable table of settings
 * channels and their handlers. Binding data (not registration) lives
 * here so tests can assert exactly which channels exist without an
 * Electron runtime. Registration through handleSecureIpc — which
 * supplies the invoke payload per call — happens in ./index.ts.
 */

async function withPublicError(
  operation: SettingsOperation,
  run: () => Promise<StarkSettings>
): Promise<StarkSettings> {
  try {
    return await run()
  } catch (error) {
    throw toPublicError(operation, error)
  }
}

export function createSettingsBindings(service: SettingsService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.settingsGet,
      invoke: () => withPublicError('get', () => service.getSettings())
    },
    {
      channel: IPC_CHANNELS.settingsUpdate,
      invoke: (payload) => withPublicError('update', () => service.updateSettings(payload))
    },
    {
      channel: IPC_CHANNELS.settingsReset,
      invoke: () => withPublicError('reset', () => service.resetSettings())
    }
  ]
}
