/**
 * Shared Workspace domain contract.
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * A Workspace is the root directory of a codebase STARK is working
 * with. Contracts use TypeScript naming (camelCase); the snake_case
 * column names stay inside the main-process repository.
 */

import type { WorkspaceChangesApi } from '../change-transactions/types'
import type { WorkspaceFilesApi } from '../workspace-files/types'
import type { WorkspaceSearchRequest, WorkspaceSearchResult } from '../workspace-search/types'

/** A persisted workspace. Always whole, never partial. */
export interface Workspace {
  readonly id: number
  readonly rootPath: string
  readonly displayName: string
  readonly createdAt: number
  readonly lastOpenedAt: number
}

/** Result of the native directory picker flow. Cancellation is normal. */
export type ChooseWorkspaceResult =
  | {
      readonly canceled: true
    }
  | {
      readonly canceled: false
      readonly workspace: Workspace
    }

/** Workspace slice of the preload bridge (see StarkApi in shared/types). */
export interface WorkspaceApi {
  getCurrent: () => Promise<Workspace | null>
  listRecent: () => Promise<Workspace[]>
  chooseDirectory: () => Promise<ChooseWorkspaceResult>
  open: (workspaceId: number) => Promise<Workspace>
  files: WorkspaceFilesApi
  /**
   * Bounded literal search inside the persisted workspace. Single clean
   * entry point (no double naming): workspace.search({...}), returning
   * matches with relative paths plus line/column/preview. Human-facing
   * only; no AI consumption yet.
   */
  search: (request: WorkspaceSearchRequest) => Promise<WorkspaceSearchResult>
  /**
   * Persistent change transactions: reviewable single-file proposals.
   * Creating never mutates disk; only explicit accept/rollback flow
   * through the Stage 8 writer. Human-facing only; no AI yet.
   */
  changes: WorkspaceChangesApi
}
