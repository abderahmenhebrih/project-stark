import type {
  ChangeTransaction,
  ChangeTransactionRequest,
  CreateFileChangeRequest,
  ListChangeTransactionsRequest,
  WorkspaceChangesApi
} from '../../../shared/change-transactions/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the change-transaction domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getWorkspaceChangesApi(): WorkspaceChangesApi | undefined {
  return getStarkApi()?.workspace.changes
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Change transactions are unavailable.'))
}

/**
 * Typed change-transaction callers.
 *
 * One proposal, one explicit accept/reject/rollback at a time — no
 * direct `window.stark` access in components, mirroring the existing
 * search and file-save helpers.
 */
export function createFileChange(request: CreateFileChangeRequest): Promise<ChangeTransaction> {
  const api = getWorkspaceChangesApi()?.create
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function getChangeTransaction(request: ChangeTransactionRequest): Promise<ChangeTransaction> {
  const api = getWorkspaceChangesApi()?.get
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function listRecentChangeTransactions(
  request: ListChangeTransactionsRequest
): Promise<readonly ChangeTransaction[]> {
  const api = getWorkspaceChangesApi()?.listRecent
  if (api === undefined) {
    return Promise.reject(new Error('Change transactions are unavailable.'))
  }
  return api(request)
}

export function acceptChangeTransaction(request: ChangeTransactionRequest): Promise<ChangeTransaction> {
  const api = getWorkspaceChangesApi()?.accept
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function rejectChangeTransaction(request: ChangeTransactionRequest): Promise<ChangeTransaction> {
  const api = getWorkspaceChangesApi()?.reject
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function rollbackChangeTransaction(request: ChangeTransactionRequest): Promise<ChangeTransaction> {
  const api = getWorkspaceChangesApi()?.rollback
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}
