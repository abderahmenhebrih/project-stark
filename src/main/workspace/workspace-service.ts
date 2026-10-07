import { basename, isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Workspace } from '../../shared/workspace/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidWorkspaceError, WorkspaceNotFoundError, WorkspaceUnavailableError } from './errors'

/** Maximum entries returned by listRecentWorkspaces. */
export const RECENT_WORKSPACES_LIMIT = 8

export interface WorkspaceServiceOptions {
  /** Clock override for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number
}

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Workspace domain service: the only main-process gateway to persisted
 * workspaces. Owns path validation, canonicalization, display names,
 * and recency; owns no SQLite connection (the repository is injected)
 * and no Electron dialog (paths enter via the IPC picker boundary).
 *
 * Async at the boundary on purpose: callers must not depend on the
 * repository being synchronous.
 */
export class WorkspaceService {
  private readonly now: () => number

  constructor(
    private readonly repository: WorkspaceRepository,
    options?: WorkspaceServiceOptions
  ) {
    this.now = options?.now ?? Date.now
  }

  /**
   * Opens a directory selected by the trusted native picker: validates
   * it is a real directory, canonicalizes it, and either reuses the
   * existing workspace (refreshing recency) or creates a new one.
   * The UNIQUE root_path constraint plus a create-then-refind fallback
   * keeps duplicate selections to a single row.
   */
  async openDirectory(rawPath: unknown): Promise<Workspace> {
    if (typeof rawPath !== 'string' || rawPath === '') {
      throw new InvalidWorkspaceError('workspace path must be provided by the system picker')
    }
    if (!isAbsolute(rawPath)) {
      throw new InvalidWorkspaceError('workspace path must be absolute')
    }
    let canonical: string
    try {
      const stats = await stat(rawPath)
      if (!stats.isDirectory()) {
        throw new WorkspaceUnavailableError()
      }
      canonical = await realpath(rawPath)
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError) {
        throw error
      }
      throw new WorkspaceUnavailableError({ cause: error })
    }
    const existing = this.repository.findByRootPath(canonical)
    if (existing !== undefined) {
      return this.touchAndRead(existing.id)
    }
    try {
      return this.repository.create({
        rootPath: canonical,
        displayName: deriveDisplayName(canonical),
        now: this.now()
      })
    } catch (error) {
      const raced = this.repository.findByRootPath(canonical)
      if (raced !== undefined) {
        return this.touchAndRead(raced.id)
      }
      throw error
    }
  }

  /**
   * The current workspace: most recently opened whose directory still
   * exists. Stale rows stay in history; a missing directory yields null
   * without crashing and without silently switching folders.
   */
  async getCurrentWorkspace(): Promise<Workspace | null> {
    const latest = this.repository.getMostRecentlyOpened()
    if (latest === undefined) {
      return null
    }
    if (!(await isExistingDirectory(latest.rootPath))) {
      return null
    }
    return latest
  }

  /** Recent workspaces, newest first. Directories are not probed here. */
  async listRecentWorkspaces(limit: number = RECENT_WORKSPACES_LIMIT): Promise<Workspace[]> {
    return this.repository.listRecent(limit)
  }

  /**
   * Reopens a persisted workspace by ID: the renderer supplies only the
   * reference, the main process resolves and validates the stored path.
   */
  async openWorkspaceById(rawId: unknown): Promise<Workspace> {
    if (!isValidId(rawId)) {
      throw new InvalidWorkspaceError('workspace reference is invalid')
    }
    const stored = this.repository.findById(rawId)
    if (stored === undefined) {
      throw new WorkspaceNotFoundError()
    }
    if (!(await isExistingDirectory(stored.rootPath))) {
      throw new WorkspaceUnavailableError()
    }
    return this.touchAndRead(stored.id)
  }

  private touchAndRead(id: number): Workspace {
    this.repository.touchLastOpened(id, this.now())
    const updated = this.repository.findById(id)
    if (updated === undefined) {
      throw new WorkspaceNotFoundError()
    }
    return updated
  }
}

/** Canonical display name: directory basename, or the path for roots. */
export function deriveDisplayName(canonicalPath: string): string {
  return basename(canonicalPath) || canonicalPath
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
