import { hashFileBytes } from '../workspace-files/file-revision'
import { encodeWriteContent, readGuardedCurrentFile } from '../workspace-files/workspace-file-write-service'
import { FileTooLargeError } from '../workspace-files/errors'
import { MAX_CHANGE_TRANSACTION_FILE_BYTES } from './limits'
import { CHANGE_CONFLICT_MESSAGE, ChangeTransactionConflictError, ChangeTransactionNoChangesError } from './errors'

/** Validated, persistence-ready single-file change candidate. */
export interface PreparedFileChange {
  readonly relativePath: string
  readonly beforeRevision: string
  readonly beforeBytes: Buffer
  readonly proposedRevision: string
  readonly proposedBytes: Buffer
}

/**
 * Shared Stage 9 file-change preparation primitive (Stage 17
 * extraction): enforces the exact same rules for single-file
 * `ChangeTransactionService.createFileChange` and multi-file
 * `ChangeSetService` creation — existing file, Workspace authority,
 * text validity, expected revision, proposed-text validation, no
 * symlink. No persistence here; callers insert atomically.
 */
export async function prepareFileChangeCandidate(
  workspaceRootPath: string,
  relativePath: string,
  expectedRevision: string,
  proposedContent: string
): Promise<PreparedFileChange> {
  const current = await readGuardedCurrentFile(workspaceRootPath, relativePath)
  if (current.bytes.byteLength > MAX_CHANGE_TRANSACTION_FILE_BYTES) {
    throw new FileTooLargeError()
  }
  if (current.revision !== expectedRevision) {
    throw new ChangeTransactionConflictError(CHANGE_CONFLICT_MESSAGE)
  }
  // Stage 8 content rules: NUL-free, well-formed UTF-16, 1 MiB cap.
  const proposedBytes = encodeWriteContent(proposedContent)
  if (proposedBytes.equals(current.bytes)) {
    throw new ChangeTransactionNoChangesError()
  }
  return {
    relativePath: current.relativePath,
    beforeRevision: current.revision,
    beforeBytes: current.bytes,
    proposedRevision: hashFileBytes(proposedBytes),
    proposedBytes
  }
}
