import { realpath, stat } from 'node:fs/promises'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidTerminalRequestError, TerminalWorkspaceUnavailableError } from './errors'

function isValidWorkspaceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Terminal domain service (Stage 11): request validation plus trusted
 * Workspace → cwd resolution. The renderer supplies only a persisted
 * workspaceId; the main process resolves the live canonical directory.
 * Never starts in HOME on failure — a missing workspace is a
 * controlled unavailable error with safe copy.
 */
export class TerminalService {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  validateCreateRequest(payload: unknown): { workspaceId: number; cols: number; rows: number } {
    if (typeof payload !== 'object' || payload === null) {
      throw new InvalidTerminalRequestError('terminal request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, cols, rows } = record
    if (!isValidWorkspaceId(workspaceId)) {
      throw new InvalidTerminalRequestError('workspace reference is invalid')
    }
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows)
    ) {
      throw new InvalidTerminalRequestError('terminal dimensions are invalid')
    }
    return { workspaceId, cols, rows }
  }

  /**
   * Resolves the trusted startup cwd for a workspace: persisted
   * rootPath → live directory check → canonical realpath. Throws the
   * safe unavailable copy when the folder is gone.
   */
  async resolveWorkspaceCwd(workspaceId: number): Promise<string> {
    const stored = this.workspaces.findById(workspaceId)
    if (stored === undefined) {
      throw new TerminalWorkspaceUnavailableError()
    }
    try {
      const stats = await stat(stored.rootPath)
      if (!stats.isDirectory()) {
        throw new TerminalWorkspaceUnavailableError()
      }
      return await realpath(stored.rootPath)
    } catch (error) {
      if (error instanceof TerminalWorkspaceUnavailableError) {
        throw error
      }
      throw new TerminalWorkspaceUnavailableError({ cause: error })
    }
  }
}
