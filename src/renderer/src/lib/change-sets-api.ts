import type { ChangeSet, ChangeSetRequest, ChangeSetsApi, ListChangeSetsRequest } from '../../../shared/change-sets/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the change-set domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getChangeSetsApi(): ChangeSetsApi | undefined {
  return getStarkApi()?.changeSets
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('We couldn’t load change sets.'))
}

/**
 * Typed change-set callers. Components use these helpers instead of
 * reaching the bridge object directly, mirroring the existing
 * session/changes helpers. Read-only: mutations continue through the
 * existing Changes API per child transaction.
 */
export function getChangeSet(request: ChangeSetRequest): Promise<ChangeSet> {
  const api = getChangeSetsApi()?.get
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}

export function listRecentChangeSets(request: ListChangeSetsRequest): Promise<readonly ChangeSet[]> {
  const api = getChangeSetsApi()?.listRecent
  if (api === undefined) {
    return unavailable()
  }
  return api(request)
}
