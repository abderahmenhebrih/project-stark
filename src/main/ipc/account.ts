import { IPC_CHANNELS } from '../../shared/constants'
import type {
  CloudAccountStatus,
  StartSignInRequest,
  StartSignInResult
} from '../../shared/cloud-account/types'
import { toPublicAccountError } from '../cloud-account/cloud-account-errors'
import type { CloudAccountService } from '../cloud-account/cloud-account-service'
import type { IpcBinding } from './binding'

function isEmptyRequest(payload: unknown): boolean {
  return payload === undefined || (typeof payload === 'object' && payload !== null && !Array.isArray(payload) && Object.keys(payload).length === 0)
}

/**
 * STARK account IPC bindings (Stage 29): exactly four invoke channels —
 * get-status, start-sign-in, cancel-sign-in, sign-out. No token, code,
 * session, URL, or callback channel exists: the renderer supplies only
 * a provider enum, and the OAuth deep-link callback is main-process
 * only (never a renderer IPC channel).
 */
export function createAccountBindings(service: CloudAccountService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.accountGetStatus,
      invoke: (payload): Promise<CloudAccountStatus> =>
        Promise.resolve()
          .then(() => {
            if (!isEmptyRequest(payload)) {
              throw new Error('cloud-auth-callback-invalid')
            }
            return service.getStatus()
          })
          .catch((error: unknown) => {
            throw toPublicAccountError('status', error)
          })
    },
    {
      channel: IPC_CHANNELS.accountStartSignIn,
      invoke: (payload): Promise<StartSignInResult> =>
        Promise.resolve()
          .then(() => {
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
              throw new Error('cloud-auth-invalid-provider')
            }
            const record = payload as Record<string, unknown>
            if (Object.keys(record).length !== 1 || !('provider' in record)) {
              throw new Error('cloud-auth-invalid-provider')
            }
            return service.startSignIn(record['provider'])
          })
          .catch((error: unknown) => {
            throw toPublicAccountError('start', error)
          })
    },
    {
      channel: IPC_CHANNELS.accountCancelSignIn,
      invoke: (payload): Promise<CloudAccountStatus> =>
        Promise.resolve()
          .then(() => {
            if (!isEmptyRequest(payload)) {
              throw new Error('cloud-auth-callback-invalid')
            }
            return service.cancelSignIn()
          })
          .catch((error: unknown) => {
            throw toPublicAccountError('cancel', error)
          })
    },
    {
      channel: IPC_CHANNELS.accountSignOut,
      invoke: (payload): Promise<CloudAccountStatus> =>
        Promise.resolve()
          .then(() => {
            if (!isEmptyRequest(payload)) {
              throw new Error('cloud-auth-callback-invalid')
            }
            return service.signOut()
          })
          .catch((error: unknown) => {
            throw toPublicAccountError('sign-out', error)
          })
    }
  ]
}

/** Validates a start-sign-in payload shape for IPC use (service re-validates). */
export function validateStartSignInRequest(raw: unknown): StartSignInRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('cloud-auth-invalid-provider')
  }
  return raw as StartSignInRequest
}
