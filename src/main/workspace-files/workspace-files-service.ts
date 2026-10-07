import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  WorkspaceDirectoryListing,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspacePathRequest,
  WorkspaceTextFile
} from '../../shared/workspace-files/types'
import type { Workspace } from '../../shared/workspace/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidWorkspaceError, WorkspaceNotFoundError, WorkspaceUnavailableError } from '../workspace/errors'
import { hashFileBytes } from './file-revision'
import {
  IGNORED_DIRECTORY_NAMES,
  MAX_DIRECTORY_ENTRIES,
  MAX_REQUEST_PATH_LENGTH,
  MAX_TEXT_FILE_BYTES
} from './limits'
import { resolveWorkspacePath } from './workspace-path'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from './errors'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validates an IPC request object into a workspace id plus raw path. */
function parsePathRequest(raw: unknown): WorkspacePathRequest {
  if (!isRecord(raw)) {
    throw new InvalidWorkspaceError('workspace file request is invalid')
  }
  const workspaceId = raw['workspaceId']
  const relativePath = raw['relativePath']
  if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  if (typeof relativePath !== 'string') {
    throw new InvalidWorkspaceError('workspace path must be a string')
  }
  if (relativePath.length > MAX_REQUEST_PATH_LENGTH) {
    throw new InvalidWorkspaceError('workspace path is too long')
  }
  return { workspaceId, relativePath }
}

async function loadWorkspace(repository: WorkspaceRepository, workspaceId: number): Promise<Workspace> {
  const workspace = repository.findById(workspaceId)
  if (workspace === undefined) {
    throw new WorkspaceNotFoundError()
  }
  return workspace
}

/**
 * Loads the workspace and confirms its root still exists as a real
 * directory. A missing root means the folder was deleted or moved;
 * symlinked roots are refused conservatively.
 */
async function requireLiveRoot(repository: WorkspaceRepository, workspaceId: number): Promise<Workspace> {
  const workspace = await loadWorkspace(repository, workspaceId)
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

function mapFileSystemError(error: unknown): never {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new WorkspacePathNotFoundError()
  }
  throw new WorkspaceUnavailableError({ cause: error })
}

function kindRank(kind: WorkspaceEntryKind): number {
  switch (kind) {
    case 'directory':
      return 0
    case 'file':
      return 1
    case 'symlink':
      return 2
    case 'other':
      return 3
  }
}

function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

/**
 * Read-only workspace inspection service: the only main-process gateway
 * to directory listings and text previews. Every operation resolves a
 * renderer-supplied workspace id plus relative path against the trusted
 * persisted root; absolute host paths can never enter. No recursion,
 * no writes, no watching — single directories and single files only.
 */
export class WorkspaceFilesService {
  constructor(private readonly repository: WorkspaceRepository) {}

  /** Lists one directory: sorted, filtered, capped, never recursive. */
  async listDirectory(rawRequest: unknown): Promise<WorkspaceDirectoryListing> {
    const request = parsePathRequest(rawRequest)
    const workspace = await requireLiveRoot(this.repository, request.workspaceId)
    let resolved
    try {
      resolved = await resolveWorkspacePath(workspace.rootPath, request.relativePath)
    } catch (error) {
      if (error instanceof WorkspacePathOutsideRootError || error instanceof WorkspaceEntryTypeError || error instanceof InvalidWorkspaceError) {
        throw error
      }
      return mapFileSystemError(error)
    }
    let entries: WorkspaceEntry[]
    try {
      entries = await readSingleDirectory(resolved.absolutePath, resolved.relativePath)
    } catch (error) {
      if (error instanceof WorkspaceEntryTypeError) {
        throw error
      }
      return mapFileSystemError(error)
    }
    const truncated = entries.length > MAX_DIRECTORY_ENTRIES
    return {
      workspaceId: workspace.id,
      relativePath: resolved.relativePath,
      entries: truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries,
      truncated
    }
  }

  /** Reads one small UTF-8 text file in full. */
  async readTextFile(rawRequest: unknown): Promise<WorkspaceTextFile> {
    const request = parsePathRequest(rawRequest)
    const workspace = await requireLiveRoot(this.repository, request.workspaceId)
    let resolved
    try {
      resolved = await resolveWorkspacePath(workspace.rootPath, request.relativePath)
    } catch (error) {
      if (error instanceof WorkspacePathOutsideRootError || error instanceof WorkspaceEntryTypeError || error instanceof InvalidWorkspaceError) {
        throw error
      }
      return mapFileSystemError(error)
    }
    let targetSize: number
    try {
      const targetStats = await lstat(resolved.absolutePath)
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        throw new WorkspaceEntryTypeError()
      }
      targetSize = targetStats.size
    } catch (error) {
      if (error instanceof WorkspaceEntryTypeError) {
        throw error
      }
      return mapFileSystemError(error)
    }
    if (targetSize > MAX_TEXT_FILE_BYTES) {
      throw new FileTooLargeError()
    }
    let buffer: Buffer
    try {
      buffer = await readFile(resolved.absolutePath)
    } catch (error) {
      return mapFileSystemError(error)
    }
    if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new FileTooLargeError()
    }
    if (buffer.includes(0)) {
      throw new UnsupportedFileError()
    }
    let content: string
    try {
      content = UTF8_DECODER.decode(buffer)
    } catch {
      throw new UnsupportedFileError()
    }
    return {
      workspaceId: workspace.id,
      relativePath: resolved.relativePath,
      content,
      size: buffer.byteLength,
      revision: hashFileBytes(buffer)
    }
  }
}

async function readSingleDirectory(absolutePath: string, relativePath: string): Promise<WorkspaceEntry[]> {
  let targetStats
  try {
    targetStats = await lstat(absolutePath)
  } catch (error) {
    return mapFileSystemError(error)
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new WorkspaceEntryTypeError()
  }
  const dirents = await readdir(absolutePath, { withFileTypes: true })
  const entries: WorkspaceEntry[] = []
  for (const dirent of dirents) {
    const kind: WorkspaceEntryKind = dirent.isSymbolicLink()
      ? 'symlink'
      : dirent.isDirectory()
        ? 'directory'
        : dirent.isFile()
          ? 'file'
          : 'other'
    if (kind === 'directory' && IGNORED_DIRECTORY_NAMES.includes(dirent.name)) {
      continue
    }
    const childRelative = relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`
    let size: number | null = null
    if (kind === 'file') {
      try {
        size = (await lstat(join(absolutePath, dirent.name))).size
      } catch {
        size = null
      }
    }
    entries.push({ name: dirent.name, relativePath: childRelative, kind, size })
  }
  entries.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || compareNames(a.name, b.name))
  return entries
}
