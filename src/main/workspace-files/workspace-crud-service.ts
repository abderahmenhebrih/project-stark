import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type {
  WorkspaceCreateRequest,
  WorkspaceCrudResult,
  WorkspacePathRequest,
  WorkspaceSetEntryNameRequest
} from '../../shared/workspace-files/types'
import type { Workspace } from '../../shared/workspace/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidWorkspaceError, WorkspaceNotFoundError, WorkspaceUnavailableError } from '../workspace/errors'
import { MAX_REQUEST_PATH_LENGTH } from './limits'
import { resolveWorkspacePath } from './workspace-path'
import {
  WorkspaceEntryExistsError,
  WorkspaceEntryTypeError,
  WorkspaceFilesError,
  WorkspaceInvalidNameError,
  WorkspacePathNotFoundError,
  WorkspaceRootProtectedError,
  WorkspaceTrashError
} from './errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseWorkspaceId(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  return raw
}

function parsePathField(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_REQUEST_PATH_LENGTH) {
    throw new InvalidWorkspaceError('workspace path is invalid')
  }
  return raw
}

/** Strict runtime validation of a renderer-supplied create request. */
export function parseCreateRequest(raw: unknown): WorkspaceCreateRequest {
  if (!isRecord(raw)) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  if (Object.keys(raw).length !== 3) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  return {
    workspaceId: parseWorkspaceId(raw['workspaceId']),
    parentPath: parsePathField(raw['parentPath']),
    name: parseNameField(raw['name'])
  }
}

/** Strict runtime validation of a renderer-supplied leaf-name change. */
export function parseSetEntryNameRequest(raw: unknown): WorkspaceSetEntryNameRequest {
  if (!isRecord(raw)) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  if (Object.keys(raw).length !== 3) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  return {
    workspaceId: parseWorkspaceId(raw['workspaceId']),
    relativePath: parsePathField(raw['relativePath']),
    newName: parseNameField(raw['newName'])
  }
}

/** Strict runtime validation of a renderer-supplied trash request. */
export function parseTrashRequest(raw: unknown): WorkspacePathRequest {
  if (!isRecord(raw)) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  if (Object.keys(raw).length !== 2) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  return {
    workspaceId: parseWorkspaceId(raw['workspaceId']),
    relativePath: parsePathField(raw['relativePath'])
  }
}

const WINDOWS_RESERVED_NAMES: readonly string[] = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]

/**
 * Validates a single leaf name (never a path). Rejects separators,
 * dot segments, NUL bytes, emptiness, overlong names, leading/trailing
 * spaces or dots, and Windows device names. Pure and unit-testable.
 */
export function parseNameField(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 255) {
    throw new WorkspaceInvalidNameError()
  }
  if (raw.includes('\0')) {
    throw new WorkspaceInvalidNameError()
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new WorkspaceInvalidNameError()
  }
  if (raw === '.' || raw === '..') {
    throw new WorkspaceInvalidNameError()
  }
  if (raw !== raw.trim() || raw.endsWith('.')) {
    throw new WorkspaceInvalidNameError()
  }
  const stem = raw.split('.')[0] ?? ''
  if (WINDOWS_RESERVED_NAMES.includes(stem.toUpperCase())) {
    throw new WorkspaceInvalidNameError()
  }
  return raw
}

/**
 * Moves one absolute target to the system Trash. Injected so unit
 * tests never touch the OS shell; production passes Electron's
 * shell.trashItem. Rejects (never falls back to permanent deletion).
 */
export type WorkspaceTrashFn = (absolutePath: string) => Promise<void>

async function loadLiveWorkspace(repository: WorkspaceRepository, workspaceId: number): Promise<Workspace> {
  const workspace = repository.findById(workspaceId)
  if (workspace === undefined) {
    throw new WorkspaceNotFoundError()
  }
  try {
    const rootStats = await lstat(workspace.rootPath)
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new WorkspaceUnavailableError()
    }
  } catch (error) {
    if (error instanceof WorkspaceUnavailableError) {
      throw error
    }
    throw new WorkspaceUnavailableError({ cause: error })
  }
  return workspace
}

function mapFsError(error: unknown): never {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new WorkspacePathNotFoundError()
  }
  if (code === 'EEXIST') {
    throw new WorkspaceEntryExistsError()
  }
  throw new WorkspaceUnavailableError({ cause: error })
}

/**
 * Direct human file operations (Explorer CRUD): create file/folder,
 * leaf-name change, move to Trash. Every call resolves a persisted
 * workspace plus renderer-supplied relative coordinates against the
 * trusted root — absolute host paths can never enter. Exclusive
 * semantics everywhere: existing targets fail instead of merging or
 * overwriting. Nothing here creates AI change transactions; the
 * service has no transaction dependency by construction.
 */
export class WorkspaceCrudService {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly trash: WorkspaceTrashFn
  ) {}

  /** Creates one empty file with exclusive semantics (no overwrite). */
  async createTextFile(rawRequest: unknown): Promise<WorkspaceCrudResult> {
    const request = parseCreateRequest(rawRequest)
    const workspace = await loadLiveWorkspace(this.repository, request.workspaceId)
    const parent = await resolveWorkspacePath(workspace.rootPath, request.parentPath).catch(mapFsErrorMaybe)
    const parentStats = await lstat(parent.absolutePath).catch(mapFsError)
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new WorkspaceEntryTypeError()
    }
    const targetAbsolute = join(parent.absolutePath, request.name)
    assertContained(parent.absolutePath, targetAbsolute)
    const targetRelative = parent.relativePath === '' ? request.name : `${parent.relativePath}/${request.name}`
    let handle
    try {
      handle = await open(targetAbsolute, 'wx', 0o644)
    } catch (error) {
      return mapFsError(error)
    }
    try {
      await handle.close()
    } catch (error) {
      throw new WorkspaceUnavailableError({ cause: error })
    }
    return { workspaceId: workspace.id, relativePath: targetRelative, kind: 'file' }
  }

  /** Creates one folder (no silent merge into an existing folder). */
  async createDirectory(rawRequest: unknown): Promise<WorkspaceCrudResult> {
    const request = parseCreateRequest(rawRequest)
    const workspace = await loadLiveWorkspace(this.repository, request.workspaceId)
    const parent = await resolveWorkspacePath(workspace.rootPath, request.parentPath).catch(mapFsErrorMaybe)
    const parentStats = await lstat(parent.absolutePath).catch(mapFsError)
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw new WorkspaceEntryTypeError()
    }
    const targetAbsolute = join(parent.absolutePath, request.name)
    assertContained(parent.absolutePath, targetAbsolute)
    const targetRelative = parent.relativePath === '' ? request.name : `${parent.relativePath}/${request.name}`
    try {
      await mkdir(targetAbsolute)
    } catch (error) {
      return mapFsError(error)
    }
    return { workspaceId: workspace.id, relativePath: targetRelative, kind: 'directory' }
  }

  /**
   * Changes one entry's leaf name inside the SAME parent (not a move).
   * Refuses overwrites, the workspace root, and symlinks. A pure
   * case-only change on case-insensitive filesystems goes through a
   * same-directory temporary hop so it never fails spuriously.
   */
  async setEntryName(rawRequest: unknown): Promise<WorkspaceCrudResult> {
    const request = parseSetEntryNameRequest(rawRequest)
    if (request.relativePath === '') {
      throw new WorkspaceRootProtectedError()
    }
    const workspace = await loadLiveWorkspace(this.repository, request.workspaceId)
    const current = await resolveWorkspacePath(workspace.rootPath, request.relativePath).catch(mapFsErrorMaybe)
    const currentStats = await lstat(current.absolutePath).catch(mapFsError)
    if (currentStats.isSymbolicLink() || (!currentStats.isFile() && !currentStats.isDirectory())) {
      throw new WorkspaceEntryTypeError()
    }
    const parentAbsolute = join(current.absolutePath, '..')
    const targetAbsolute = join(parentAbsolute, request.newName)
    assertContained(parentAbsolute, targetAbsolute)
    const slash = current.relativePath.lastIndexOf('/')
    const parentRelative = slash === -1 ? '' : current.relativePath.slice(0, slash)
    const targetRelative = parentRelative === '' ? request.newName : `${parentRelative}/${request.newName}`
    if (targetRelative === current.relativePath) {
      return {
        workspaceId: workspace.id,
        relativePath: current.relativePath,
        kind: currentStats.isDirectory() ? 'directory' : 'file'
      }
    }
    let destStats
    try {
      destStats = await lstat(targetAbsolute)
    } catch (error) {
      const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new WorkspaceUnavailableError({ cause: error })
      }
      destStats = null
    }
    if (destStats !== null) {
      if (await isSameEntryCaseOnly(current.absolutePath, targetAbsolute)) {
        // Case-only change resolving to the same entry on a
        // case-insensitive filesystem: hop through a same-directory
        // temporary name so filesystems that reject in-place case
        // changes still succeed without ever touching another entry.
        const tempAbsolute = join(parentAbsolute, `.stark-tmp-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`)
        try {
          await rename(current.absolutePath, tempAbsolute)
          await rename(tempAbsolute, targetAbsolute)
        } catch (error) {
          return mapFsError(error)
        }
        return {
          workspaceId: workspace.id,
          relativePath: targetRelative,
          kind: currentStats.isDirectory() ? 'directory' : 'file'
        }
      }
      throw new WorkspaceEntryExistsError()
    }
    try {
      await rename(current.absolutePath, targetAbsolute)
    } catch (error) {
      return mapFsError(error)
    }
    return {
      workspaceId: workspace.id,
      relativePath: targetRelative,
      kind: currentStats.isDirectory() ? 'directory' : 'file'
    }
  }

  /**
   * Moves one file, folder, or symlink to the system Trash via the
   * injected Trash function. The workspace root is protected.
   * Failures reject with safe copy — never permanent deletion.
   */
  async moveToTrash(rawRequest: unknown): Promise<WorkspaceCrudResult> {
    const request = parseTrashRequest(rawRequest)
    if (request.relativePath === '') {
      throw new WorkspaceRootProtectedError()
    }
    const workspace = await loadLiveWorkspace(this.repository, request.workspaceId)
    const current = await resolveWorkspacePath(workspace.rootPath, request.relativePath).catch(mapFsErrorMaybe)
    const currentStats = await lstat(current.absolutePath).catch(mapFsError)
    const kind = currentStats.isDirectory() && !currentStats.isSymbolicLink()
      ? 'directory'
      : currentStats.isFile() && !currentStats.isSymbolicLink()
        ? 'file'
        : currentStats.isSymbolicLink()
          ? 'symlink'
          : null
    if (kind === null) {
      throw new WorkspaceEntryTypeError()
    }
    try {
      await this.trash(current.absolutePath)
    } catch (error) {
      throw new WorkspaceTrashError({ cause: error })
    }
    return { workspaceId: workspace.id, relativePath: current.relativePath, kind }
  }
}

function mapFsErrorMaybe(error: unknown): never {
  // Domain errors already carry safe meaning — rethrow untouched so
  // the IPC mapper renders their specific copy (not a generic one).
  if (error instanceof WorkspaceFilesError || error instanceof InvalidWorkspaceError) {
    throw error
  }
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new WorkspacePathNotFoundError()
  }
  throw new WorkspaceUnavailableError({ cause: error })
}

/**
 * True only for a pure case-only change to the SAME entry on a
 * case-insensitive filesystem: the canonical destination matches the
 * canonical source ignoring case. (realpath normalizes stored case,
 * so exact inequality must NOT be required.) On case-sensitive
 * filesystems this is always false, so a colliding name is refused
 * instead of overwritten.
 */
async function isSameEntryCaseOnly(currentAbsolute: string, targetAbsolute: string): Promise<boolean> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return false
  }
  let targetReal: string
  try {
    targetReal = await realpath(targetAbsolute)
  } catch {
    return false
  }
  return targetReal.toLowerCase() === currentAbsolute.toLowerCase()
}

/** Defense-in-depth: the computed target must stay under its parent. */
function assertContained(parentAbsolute: string, targetAbsolute: string): void {
  const difference = relative(parentAbsolute, targetAbsolute)
  if (difference === '' || difference.startsWith('..')) {
    throw new WorkspaceEntryTypeError()
  }
}
