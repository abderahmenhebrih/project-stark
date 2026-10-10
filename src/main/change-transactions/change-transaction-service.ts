import { TextDecoder } from 'node:util'
import type {
  ChangeTransaction,
  ChangeTransactionFile,
  ChangeTransactionStatus,
  CreateFileChangeRequest
} from '../../shared/change-transactions/types'
import type { Workspace } from '../../shared/workspace/types'
import type {
  ChangeTransactionRepository,
  StoredChangeTransaction,
  StoredChangeTransactionFile
} from '../database/repositories/change-transaction-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { InvalidWorkspaceError, WorkspaceNotFoundError } from '../workspace/errors'
import { hashFileBytes, isValidRevision } from '../workspace-files/file-revision'
import { MAX_REQUEST_PATH_LENGTH } from '../workspace-files/limits'
import {
  requireLiveWorkspace,
  type WorkspaceFileWriteService
} from '../workspace-files/workspace-file-write-service'
import { WorkspaceFileConflictError } from '../workspace-files/errors'
import {
  MAX_FILES_PER_CHANGE_TRANSACTION,
  MAX_RECENT_CHANGE_TRANSACTIONS
} from './limits'
import { prepareFileChangeCandidate } from './prepare-file-change'
import type { BinaryImportAcceptor } from '../attachment-import/attachment-import-service'
import { binaryImportPublicInfo, isAttachmentImportManifest } from '../attachment-import/manifest'
import {
  CHANGE_CONFLICT_MESSAGE,
  CHANGE_ROLLBACK_CONFLICT_MESSAGE,
  ChangeTransactionConflictError,
  ChangeTransactionNotFoundError,
  ChangeTransactionStateError,
  CorruptChangeTransactionError
} from './errors'

const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

/** Strict runtime validation: every field checked, unknown fields rejected. */
export function parseCreateFileChangeRequest(raw: unknown): CreateFileChangeRequest {
  if (!isRecord(raw) || !hasExactKeys(raw, ['workspaceId', 'relativePath', 'expectedRevision', 'proposedContent'])) {
    throw new InvalidWorkspaceError('change proposal request is invalid')
  }
  const workspaceId = raw['workspaceId']
  const relativePath = raw['relativePath']
  const expectedRevision = raw['expectedRevision']
  const proposedContent = raw['proposedContent']
  if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > MAX_REQUEST_PATH_LENGTH) {
    throw new InvalidWorkspaceError('workspace path is invalid')
  }
  if (!isValidRevision(expectedRevision)) {
    throw new InvalidWorkspaceError('workspace file revision is invalid')
  }
  if (typeof proposedContent !== 'string') {
    throw new InvalidWorkspaceError('proposed change content is invalid')
  }
  return { workspaceId, relativePath, expectedRevision, proposedContent }
}

/** Strict runtime validation for single-transaction operations. */
export function parseTransactionIdRequest(raw: unknown): number {
  if (!isRecord(raw) || !hasExactKeys(raw, ['transactionId'])) {
    throw new InvalidWorkspaceError('change transaction request is invalid')
  }
  const transactionId = raw['transactionId']
  if (typeof transactionId !== 'number' || !Number.isInteger(transactionId) || transactionId <= 0) {
    throw new InvalidWorkspaceError('change transaction reference is invalid')
  }
  return transactionId
}

/** Strict runtime validation for workspace-scoped history. */
export function parseWorkspaceHistoryRequest(raw: unknown): number {
  if (!isRecord(raw) || !hasExactKeys(raw, ['workspaceId'])) {
    throw new InvalidWorkspaceError('change history request is invalid')
  }
  const workspaceId = raw['workspaceId']
  if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new InvalidWorkspaceError('workspace reference is invalid')
  }
  return workspaceId
}

function decodeCheckpoint(bytes: Buffer): string {
  try {
    return STRICT_DECODER.decode(bytes)
  } catch {
    throw new CorruptChangeTransactionError()
  }
}

function verifyStoredFile(file: StoredChangeTransactionFile): void {
  if (hashFileBytes(file.beforeBytes) !== file.beforeRevision) {
    throw new CorruptChangeTransactionError()
  }
  if (hashFileBytes(file.proposedBytes) !== file.proposedRevision) {
    throw new CorruptChangeTransactionError()
  }
}

function toPublicFile(file: StoredChangeTransactionFile): ChangeTransactionFile {
  verifyStoredFile(file)
  const base: ChangeTransactionFile = {
    relativePath: file.relativePath,
    beforeRevision: file.beforeRevision,
    proposedRevision: file.proposedRevision,
    appliedRevision: file.appliedRevision,
    beforeContent: decodeCheckpoint(file.beforeBytes),
    proposedContent: decodeCheckpoint(file.proposedBytes)
  }
  // Binary attachment imports (Step 3) persist a review manifest as
  // the proposed bytes. The renderer renders an asset card from the
  // structured metadata — never a diff of the raw manifest.
  const binaryImport = binaryImportPublicInfo(file.proposedBytes)
  return binaryImport === null ? base : { ...base, binaryImport }
}

function toPublicTransaction(
  header: StoredChangeTransaction,
  files: readonly StoredChangeTransactionFile[]
): ChangeTransaction {
  return {
    id: header.id,
    workspaceId: header.workspaceId,
    status: header.status satisfies ChangeTransactionStatus,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    appliedAt: header.appliedAt,
    rejectedAt: header.rejectedAt,
    rolledBackAt: header.rolledBackAt,
    files: files.map(toPublicFile)
  }
}

/**
 * Higher-level safety workflow over the Stage 8 writer, which remains
 * the ONLY component that replaces file bytes. Proposals persist exact
 * checkpoints; Accept and Rollback both re-validate staleness through
 * the writer, so external work is never overwritten.
 */
export class ChangeTransactionService {
  private readonly workspaces: WorkspaceRepository
  private readonly transactions: ChangeTransactionRepository
  private readonly writer: WorkspaceFileWriteService
  private readonly now: () => number
  private readonly binaryImport: BinaryImportAcceptor | undefined

  constructor(
    workspaces: WorkspaceRepository,
    transactions: ChangeTransactionRepository,
    writer: WorkspaceFileWriteService,
    now: () => number = Date.now,
    binaryImport?: BinaryImportAcceptor
  ) {
    this.workspaces = workspaces
    this.transactions = transactions
    this.writer = writer
    this.now = now
    this.binaryImport = binaryImport
  }

  /**
   * Persists a single-file proposal WITHOUT touching the project file.
   * Fails as a conflict when the disk moved past the read revision, and
   * as a no-changes outcome when the proposal equals current bytes.
   * Candidate validation is shared with multi-file Change Sets through
   * `prepareFileChangeCandidate` — one rule set, no drift.
   */
  async createFileChange(rawRequest: unknown): Promise<ChangeTransaction> {
    const request = parseCreateFileChangeRequest(rawRequest)
    const workspace = await requireLiveWorkspace(this.workspaces, request.workspaceId)
    const candidate = await prepareFileChangeCandidate(
      workspace.rootPath,
      request.relativePath,
      request.expectedRevision,
      request.proposedContent
    )
    const timestamp = this.now()
    const id = this.transactions.createWithFiles({ workspaceId: workspace.id, now: timestamp }, [
      {
        relativePath: candidate.relativePath,
        beforeRevision: candidate.beforeRevision,
        beforeBytes: candidate.beforeBytes,
        proposedRevision: candidate.proposedRevision,
        proposedBytes: candidate.proposedBytes
      }
    ])
    return this.readPublicTransaction(id)
  }

  /** Loads one transaction after proving its workspace still exists. */
  async getTransaction(rawRequest: unknown): Promise<ChangeTransaction> {
    const transactionId = parseTransactionIdRequest(rawRequest)
    return this.readPublicTransaction(transactionId)
  }

  /** Newest-first history for one workspace, capped at 20. */
  async listRecentTransactions(rawRequest: unknown): Promise<readonly ChangeTransaction[]> {
    const workspaceId = parseWorkspaceHistoryRequest(rawRequest)
    this.requireExistingWorkspace(workspaceId)
    const headers = this.transactions.listRecentForWorkspace(workspaceId, MAX_RECENT_CHANGE_TRANSACTIONS)
    return headers.map((header) => toPublicTransaction(header, this.transactions.findFiles(header.id)))
  }

  /**
   * First and only point at which a proposal may change disk: delegates
   * to the Stage 8 writer with the checkpoint as the stale guard, then
   * records the applied revision. Stays pending on conflict.
   */
  async acceptTransaction(rawRequest: unknown): Promise<ChangeTransaction> {
    const transactionId = parseTransactionIdRequest(rawRequest)
    const loaded = this.loadStoredTransaction(transactionId)
    this.requireStatus(loaded.header, 'pending')
    const file = this.requireSingleFile(loaded.files)
    // Binary attachment imports (Step 3) never flow through the text
    // writer: the import service re-validates the reviewed manifest
    // and copies exact bytes. Text proposals continue below.
    if (isAttachmentImportManifest(file.proposedBytes)) {
      if (this.binaryImport === undefined) {
        throw new CorruptChangeTransactionError()
      }
      await this.binaryImport.acceptBinaryImport(transactionId)
      return this.readPublicTransaction(transactionId)
    }
    const proposedContent = decodeCheckpoint(file.proposedBytes)
    let appliedRevision: string
    try {
      const result = await this.writer.writeTextFile({
        workspaceId: loaded.workspace.id,
        relativePath: file.relativePath,
        expectedRevision: file.beforeRevision,
        content: proposedContent
      })
      appliedRevision = result.revision
    } catch (error) {
      if (error instanceof WorkspaceFileConflictError) {
        throw new ChangeTransactionConflictError(CHANGE_CONFLICT_MESSAGE)
      }
      throw error
    }
    if (appliedRevision !== file.proposedRevision) {
      throw new CorruptChangeTransactionError()
    }
    const marked = this.transactions.markApplied(transactionId, appliedRevision, this.now())
    if (!marked) {
      throw new ChangeTransactionStateError()
    }
    return this.readPublicTransaction(transactionId)
  }

  /** Pending → rejected. Zero filesystem writes; history is retained. */
  async rejectTransaction(rawRequest: unknown): Promise<ChangeTransaction> {
    const transactionId = parseTransactionIdRequest(rawRequest)
    const loaded = this.loadStoredTransaction(transactionId)
    this.requireStatus(loaded.header, 'pending')
    const marked = this.transactions.markRejected(transactionId, this.now())
    if (!marked) {
      throw new ChangeTransactionStateError()
    }
    return this.readPublicTransaction(transactionId)
  }

  /**
   * Restores the exact checkpoint, guarded by the applied revision: an
   * external change after apply turns rollback into a conflict instead
   * of an overwrite. Stays applied on conflict.
   */
  async rollbackTransaction(rawRequest: unknown): Promise<ChangeTransaction> {
    const transactionId = parseTransactionIdRequest(rawRequest)
    const loaded = this.loadStoredTransaction(transactionId)
    this.requireStatus(loaded.header, 'applied')
    const file = this.requireSingleFile(loaded.files)
    // Binary rollback restores the reviewed absent checkpoint by
    // deleting the imported file (guarded by the applied revision).
    if (isAttachmentImportManifest(file.proposedBytes)) {
      if (this.binaryImport === undefined) {
        throw new CorruptChangeTransactionError()
      }
      await this.binaryImport.rollbackBinaryImport(transactionId)
      return this.readPublicTransaction(transactionId)
    }
    if (file.appliedRevision === null) {
      throw new CorruptChangeTransactionError()
    }
    const beforeContent = decodeCheckpoint(file.beforeBytes)
    let restoredRevision: string
    try {
      const result = await this.writer.writeTextFile({
        workspaceId: loaded.workspace.id,
        relativePath: file.relativePath,
        expectedRevision: file.appliedRevision,
        content: beforeContent
      })
      restoredRevision = result.revision
    } catch (error) {
      if (error instanceof WorkspaceFileConflictError) {
        throw new ChangeTransactionConflictError(CHANGE_ROLLBACK_CONFLICT_MESSAGE)
      }
      throw error
    }
    if (restoredRevision !== file.beforeRevision) {
      throw new CorruptChangeTransactionError()
    }
    const marked = this.transactions.markRolledBack(transactionId, this.now())
    if (!marked) {
      throw new ChangeTransactionStateError()
    }
    return this.readPublicTransaction(transactionId)
  }

  private requireExistingWorkspace(workspaceId: number): Workspace {
    const workspace = this.workspaces.findById(workspaceId)
    if (workspace === undefined) {
      throw new WorkspaceNotFoundError()
    }
    return workspace
  }

  private loadStoredTransaction(transactionId: number): {
    header: StoredChangeTransaction
    files: StoredChangeTransactionFile[]
    workspace: Workspace
  } {
    const header = this.transactions.findTransaction(transactionId)
    if (header === undefined) {
      throw new ChangeTransactionNotFoundError()
    }
    const workspace = this.requireExistingWorkspace(header.workspaceId)
    return { header, files: this.transactions.findFiles(transactionId), workspace }
  }

  private requireStatus(header: StoredChangeTransaction, status: ChangeTransactionStatus): void {
    if (header.status !== status) {
      throw new ChangeTransactionStateError()
    }
  }

  private requireSingleFile(files: readonly StoredChangeTransactionFile[]): StoredChangeTransactionFile {
    if (files.length !== MAX_FILES_PER_CHANGE_TRANSACTION) {
      throw new CorruptChangeTransactionError()
    }
    const file = files[0]
    if (file === undefined) {
      throw new CorruptChangeTransactionError()
    }
    verifyStoredFile(file)
    return file
  }

  private readPublicTransaction(transactionId: number): ChangeTransaction {
    const loaded = this.loadStoredTransaction(transactionId)
    return toPublicTransaction(loaded.header, loaded.files)
  }
}
