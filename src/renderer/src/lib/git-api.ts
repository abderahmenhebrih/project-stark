import type { GitApi, GitDiffRequest, GitDiffResult, GitWorkspaceState } from '../../../shared/git/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the read-only Git domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getGitApi(): GitApi | undefined {
  return getStarkApi()?.git
}

/**
 * Typed read-only Git callers.
 *
 * Components use these helpers instead of direct `window.stark.git`
 * access, mirroring the search/changes helpers. No polling here —
 * callers fetch explicitly (tab open, Refresh, workspace change).
 */
export function getGitStatus(workspaceId: number): Promise<GitWorkspaceState> {
  const api = getGitApi()?.getStatus
  if (api === undefined) {
    return Promise.reject(new Error('Git is not available on this system.'))
  }
  return api(workspaceId)
}

export function getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
  const api = getGitApi()?.getDiff
  if (api === undefined) {
    return Promise.reject(new Error('We couldn’t read this Git diff.'))
  }
  return api(request)
}
