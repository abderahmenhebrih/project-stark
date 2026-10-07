import { randomBytes } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  WorkspaceTextFileWriteRequest,
  WorkspaceTextFileWriteResult
} from '../../shared/workspace-files/types'
import type { Workspace } from '../../shared/workspace/types'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidWorkspaceError, WorkspaceNotFoundError, WorkspaceUnavailableError } from '../workspace/errors'
import { hashFileBytes, isValidRevision } from './file-revision'
import { MAX_REQUEST_PATH_LENGTH, MAX_WRITABLE_TEXT_FILE_BYTES } from './limits'
import { resolveWorkspacePath, type ResolvedWorkspacePath } from './workspace-path'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspaceFileConflictError,
  WorkspaceFileWriteError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from './errors'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Prefix for same-directory temp files. Never renderer controlled. */
const TEMP_FILE_PREFIX = '.stark-tmp-'

/**
 * Final filesystem step, abstracted so failure-atomicity tests can force
 * a replacement failure deterministically. Production uses atomic
 * same-directory rename.
 */
export interface WorkspaceFileWriteFileSystem {
  readonly replaceFile: (tempPath: string, targetPath: string) => Promise<void>
}

const DEFAULT_FILE_SYSTEM: WorkspaceFileWriteFileSystem = {
  replaceFile: (tempPath, targetPath) => rename(tempPath, targetPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Strict runtime validation of a renderer-supplied save request.
 * Unknown extra fields are ignored; every known field is type-checked.
 */
export function parseWriteRequest(raw: unknown): WorkspaceTextFileWriteRequest {
  if (!isRecord(raw)) {
    throw new InvalidWorkspaceError('workspace file write request is invalid')
  }
  const workspaceId = raw['workspaceId']
  const relativePath = raw['relativePath']
  const expectedRevision = raw['expectedRevision']
  const content = raw['content']
  if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  if (typeof relativePath !== 'string' || relativePath.length > MAX_REQUEST_PATH_LENGTH) {
    throw new InvalidWorkspaceError('workspace path is invalid')
  }
  if (!isValidRevision(expectedRevision)) {
    throw new InvalidWorkspaceError('workspace file revision is invalid')
  }
  if (typeof content !== 'string') {
    throw new InvalidWorkspaceError('workspace file content is invalid')
  }
  return { workspaceId, relativePath, expectedRevision, content }
}

/**
 * Validates new content and encodes it as UTF-8 without trimming,
 * normalizing, or reformatting: indentation, LF/CRLF, Unicode, and a
 * present-or-absent final newline are all preserved byte-for-byte.
 */
export function encodeWriteContent(content: string): Buffer {
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (content.includes('\0')) {
    throw new UnsupportedFileError()
  }
  assertWellFormedUtf16(content)
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > MAX_WRITABLE_TEXT_FILE_BYTES) {
    throw new FileTooLargeError()
  }
  return bytes
}

/** Rejects lone UTF-16 surrogates; valid pairs pass through untouched. */
function assertWellFormedUtf16(content: string): void {
  for (let i = 0; i < content.length; i += 1) {
    const unit = content.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(i + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new UnsupportedFileError()
      }
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new UnsupportedFileError()
    }
  }
}

/**
 * Resolves a persisted workspace and proves its root is still a live,
 * non-symlinked directory. Shared with the Stage 9 transaction service
 * so workspace authority is never duplicated.
 */
export async function requireLiveWorkspace(
  repository: WorkspaceRepository,
  workspaceId: number
): Promise<Workspace> {
  return requireLiveRoot(repository, workspaceId)
}

async function requireLiveRoot(repository: WorkspaceRepository, workspaceId: number): Promise<Workspace> {
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

function mapFileSystemError(error: unknown): never {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    throw new WorkspacePathNotFoundError()
  }
  throw new WorkspaceUnavailableError({ cause: error })
}

interface CurrentFile {
  readonly bytes: Buffer
  readonly revision: string
  readonly mode: number
}

/** Exact current bytes plus SHA-256, without filesystem mode details. */
export interface GuardedCurrentFile {
  readonly bytes: Buffer
  readonly revision: string
  /** Normalized request form: '' is never returned here (files only). */
  readonly relativePath: string
}

/**
 * Re-resolves the target through Stage 6 security and reads its exact
 * current bytes (regular file only, symlinks refused, size-capped,
 * strict UTF-8 text only). Shared with the Stage 9 transaction service
 * so checkpoint reads never duplicate stale-checking or text policy.
 */
export async function readGuardedCurrentFile(
  rootPath: string,
  relativePath: string
): Promise<GuardedCurrentFile> {
  const current = await readCurrentFile(rootPath, relativePath)
  const resolved = await resolveWorkspacePath(rootPath, relativePath)
  return { bytes: current.bytes, revision: current.revision, relativePath: resolved.relativePath }
}

/**
 * Re-resolves the target and reads its exact current bytes: regular
 * file only, symlinks forbidden, size-capped, strict UTF-8 text only.
 */
async function readCurrentFile(rootPath: string, relativePath: string): Promise<CurrentFile> {
  let resolved: ResolvedWorkspacePath
  try {
    resolved = await resolveWorkspacePath(rootPath, relativePath)
  } catch (error) {
    if (
      error instanceof WorkspacePathNotFoundError ||
      error instanceof WorkspacePathOutsideRootError ||
      error instanceof WorkspaceEntryTypeError ||
      error instanceof InvalidWorkspaceError
    ) {
      throw error
    }
    return mapFileSystemError(error)
  }
  let stats
  try {
    stats = await lstat(resolved.absolutePath)
  } catch (error) {
    return mapFileSystemError(error)
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WorkspaceEntryTypeError()
  }
  if (stats.size > MAX_WRITABLE_TEXT_FILE_BYTES) {
    throw new FileTooLargeError()
  }
  let bytes: Buffer
  try {
    bytes = await readFile(resolved.absolutePath)
  } catch (error) {
    return mapFileSystemError(error)
  }
  if (bytes.byteLength > MAX_WRITABLE_TEXT_FILE_BYTES) {
    throw new FileTooLargeError()
  }
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (bytes.includes(0)) {
    throw new UnsupportedFileError()
  }
  try {
    UTF8_DECODER.decode(bytes)
  } catch {
    throw new UnsupportedFileError()
  }
  return { bytes, revision: hashFileBytes(bytes), mode: stats.mode }
}

function tempFileName(): string {
  return `${TEMP_FILE_PREFIX}${String(process.pid)}-${randomBytes(8).toString('hex')}`
}

async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath)
  } catch {
    // Best effort: the temp name is unique per operation, so a failed
    // removal cannot be mistaken for another operation's file.
  }
}

/**
 * The ONLY file-mutation authority (Stage 8): stale-safe update of one
 * EXISTING regular text file. No create, delete, rename, move, copy, or
 * Save-As — missing files, directories, symlinks, and non-regular files
 * are all refused.
 */
export class WorkspaceFileWriteService {
  private readonly repository: WorkspaceRepository
  private readonly fileSystem: WorkspaceFileWriteFileSystem

  constructor(repository: WorkspaceRepository, fileSystem: WorkspaceFileWriteFileSystem = DEFAULT_FILE_SYSTEM) {
    this.repository = repository
    this.fileSystem = fileSystem
  }

  async writeTextFile(rawRequest: unknown): Promise<WorkspaceTextFileWriteResult> {
    const request = parseWriteRequest(rawRequest)
    const newBytes = encodeWriteContent(request.content)
    const workspace = await requireLiveRoot(this.repository, request.workspaceId)

    const current = await readCurrentFile(workspace.rootPath, request.relativePath)
    if (current.revision !== request.expectedRevision) {
      throw new WorkspaceFileConflictError()
    }
    if (newBytes.equals(current.bytes)) {
      const resolved = await resolveWorkspacePath(workspace.rootPath, request.relativePath)
      return {
        workspaceId: workspace.id,
        relativePath: resolved.relativePath,
        size: current.bytes.byteLength,
        revision: current.revision,
        changed: false
      }
    }

    const resolved = await resolveWorkspacePath(workspace.rootPath, request.relativePath)
    const targetPath = resolved.absolutePath
    const tempPath = join(dirname(targetPath), tempFileName())
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(tempPath, 'wx', 0x600)
      await handle.writeFile(newBytes)
      await handle.sync()
      await handle.close()
      handle = null
      try {
        // Best effort: POSIX mode bits (notably executable bits) follow
        // the original; Windows honors only read-only-ness, which a
        // same-user temp file already satisfies.
        await chmod(tempPath, current.mode & 0o7777)
      } catch {
        // Non-fatal by design — documented in the README.
      }
      // Final stale/security re-check as close to replacement as
      // practical: an external change racing the write still wins.
      const latest = await readCurrentFile(workspace.rootPath, request.relativePath)
      if (latest.revision !== request.expectedRevision) {
        await removeTempFile(tempPath)
        throw new WorkspaceFileConflictError()
      }
      try {
        await this.fileSystem.replaceFile(tempPath, targetPath)
      } catch (error) {
        await removeTempFile(tempPath)
        if (error instanceof WorkspaceFileConflictError) {
          throw error
        }
        throw new WorkspaceFileWriteError({ cause: error })
      }
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close()
        } catch {
          // Ignore close failures — removal below is what matters.
        }
      }
      await removeTempFile(tempPath)
      if (
        error instanceof WorkspaceFileConflictError ||
        error instanceof WorkspaceFileWriteError ||
        error instanceof WorkspacePathNotFoundError ||
        error instanceof WorkspaceEntryTypeError ||
        error instanceof InvalidWorkspaceError ||
        error instanceof FileTooLargeError ||
        error instanceof UnsupportedFileError ||
        error instanceof WorkspaceNotFoundError ||
        error instanceof WorkspaceUnavailableError
      ) {
        throw error
      }
      const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspacePathNotFoundError()
      }
      throw new WorkspaceFileWriteError({ cause: error })
    }
    return {
      workspaceId: workspace.id,
      relativePath: resolved.relativePath,
      size: newBytes.byteLength,
      revision: hashFileBytes(newBytes),
      changed: true
    }
  }
}
