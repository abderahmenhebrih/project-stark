import type {
  ChangeSet,
  ChangeSetItem,
  ChangeSetKind,
  ChangeSetStatus
} from '../../shared/change-sets/types'
import type { ChangeTransaction } from '../../shared/change-transactions/types'
import type { Workspace } from '../../shared/workspace/types'
import type { ChangeSetRepository, NewChangeSetItem } from '../database/repositories/change-set-repository'
import type {
  StoredChangeTransaction,
  StoredChangeTransactionFile
} from '../database/repositories/change-transaction-repository'
import type { ChangeTransactionRepository } from '../database/repositories/change-transaction-repository'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { WorkspaceNotFoundError } from '../workspace/errors'
import { hashFileBytes, isValidRevision } from '../workspace-files/file-revision'
import { requireLiveWorkspace } from '../workspace-files/workspace-file-write-service'
import { prepareFileChangeCandidate } from '../change-transactions/prepare-file-change'
import { binaryImportPublicInfo } from '../attachment-import/manifest'
import { MAX_GROUP_CHANGE_SET_FILES, MAX_RECENT_CHANGE_SETS } from './limits'
import { ChangeSetNotFoundError, InvalidChangeSetRequestError } from './errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** One validated file entry for atomic Change Set creation. */
export interface NewChangeSetFile {
  readonly relativePath: string
  readonly expectedRevision: string
  readonly proposedContent: string
  readonly fileSummary: string
}

function validateFileSummary(summary: unknown): string {
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw new InvalidChangeSetRequestError('change-set file summary is invalid')
  }
  return summary.trim()
}

/** Derives group state from child statuses — never persisted. */
export function deriveChangeSetStatus(statuses: readonly ChangeTransaction['status'][]): ChangeSetStatus {
  if (statuses.every((status) => status === 'pending')) {
    return 'pending'
  }
  if (statuses.some((status) => status === 'pending')) {
    return 'partially_resolved'
  }
  return 'resolved'
}

export function parseGetChangeSetRequest(raw: unknown): number {
  if (!isRecord(raw) || !hasExactKeys(raw, ['changeSetId'])) {
    throw new InvalidChangeSetRequestError('change set request is invalid')
  }
  const changeSetId = raw['changeSetId']
  if (!isValidId(changeSetId)) {
    throw new InvalidChangeSetRequestError('change set reference is invalid')
  }
  return changeSetId
}

export function parseListChangeSetsRequest(raw: unknown): number {
  if (!isRecord(raw) || !hasExactKeys(raw, ['workspaceId'])) {
    throw new InvalidChangeSetRequestError('change set history request is invalid')
  }
  const workspaceId = raw['workspaceId']
  if (!isValidId(workspaceId)) {
    throw new InvalidChangeSetRequestError('workspace reference is invalid')
  }
  return workspaceId
}

/**
 * Change-set domain service (Stage 17): atomically persists grouped
 * multi-file proposals and serves grouped review reads. No disk
 * writes — state transitions stay delegated to
 * `ChangeTransactionService`. Candidate validation reuses the shared
 * Stage 9 primitive, so single-file and multi-file creation enforce
 * identical file rules.
 */
export class ChangeSetService {
  private readonly now: () => number

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly changeSets: ChangeSetRepository,
    private readonly transactions: ChangeTransactionRepository,
    now: () => number = Date.now
  ) {
    this.now = now
  }

  /**
   * Validates every file through the shared Stage 9 primitive and
   * persists the set plus all child pending transactions, file rows,
   * and item links in ONE atomic repository call. Either the whole
   * aggregate exists or nothing does.
   */
  async createAiChangeSet(
    workspaceId: number,
    summary: string,
    files: readonly NewChangeSetFile[]
  ): Promise<ChangeSet> {
    if (!isValidId(workspaceId)) {
      throw new InvalidChangeSetRequestError('workspace reference is invalid')
    }
    if (typeof summary !== 'string' || summary.trim() === '') {
      throw new InvalidChangeSetRequestError('change-set summary is invalid')
    }
    if (files.length === 0) {
      throw new InvalidChangeSetRequestError('change-set files are invalid')
    }
    const workspace = await requireLiveWorkspace(this.workspaces, workspaceId)
    const items: NewChangeSetItem[] = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file === undefined) {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      if (typeof file.relativePath !== 'string' || typeof file.proposedContent !== 'string') {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      if (!isValidRevision(file.expectedRevision)) {
        throw new InvalidChangeSetRequestError('workspace file revision is invalid')
      }
      const fileSummary = validateFileSummary(file.fileSummary)
      const candidate = await prepareFileChangeCandidate(
        workspace.rootPath,
        file.relativePath,
        file.expectedRevision,
        file.proposedContent
      )
      items.push({
        relativePath: candidate.relativePath,
        beforeRevision: candidate.beforeRevision,
        beforeBytes: candidate.beforeBytes,
        proposedRevision: candidate.proposedRevision,
        proposedBytes: candidate.proposedBytes,
        ordinal: index,
        fileSummary
      })
    }
    const timestamp = this.now()
    const id = this.changeSets.createChangeSet(
      { workspaceId: workspace.id, kind: 'ai_multi_file_proposal', summary: summary.trim(), now: timestamp },
      items
    )
    return this.readPublicChangeSet(id)
  }

  /** Loads one Change Set after proving workspace ownership. */
  async getChangeSet(rawRequest: unknown): Promise<ChangeSet> {
    const changeSetId = parseGetChangeSetRequest(rawRequest)
    return this.readPublicChangeSet(changeSetId)
  }

  /** Newest-first Change Sets for one workspace, capped at 20. */
  async listRecentChangeSets(rawRequest: unknown): Promise<readonly ChangeSet[]> {
    const workspaceId = parseListChangeSetsRequest(rawRequest)
    this.requireExistingWorkspace(workspaceId)
    const headers = this.changeSets.listRecentForWorkspace(workspaceId, MAX_RECENT_CHANGE_SETS)
    return headers.map((header) => this.assemble(header.id))
  }

  private requireExistingWorkspace(workspaceId: number): Workspace {
    const workspace = this.workspaces.findById(workspaceId)
    if (workspace === undefined) {
      throw new WorkspaceNotFoundError()
    }
    return workspace
  }

  private toPublicTransaction(
    header: StoredChangeTransaction,
    files: readonly StoredChangeTransactionFile[]
  ): ChangeTransaction {
    if (files.length !== 1 || files[0] === undefined) {
      throw new InvalidChangeSetRequestError('change-set child transaction is invalid')
    }
    const file = files[0]
    if (hashFileBytes(file.beforeBytes) !== file.beforeRevision) {
      throw new InvalidChangeSetRequestError('change-set child transaction is invalid')
    }
    if (hashFileBytes(file.proposedBytes) !== file.proposedRevision) {
      throw new InvalidChangeSetRequestError('change-set child transaction is invalid')
    }
    const binaryImport = binaryImportPublicInfo(file.proposedBytes)
    return {
      id: header.id,
      workspaceId: header.workspaceId,
      status: header.status,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      appliedAt: header.appliedAt,
      rejectedAt: header.rejectedAt,
      rolledBackAt: header.rolledBackAt,
      files: [
        {
          relativePath: file.relativePath,
          beforeRevision: file.beforeRevision,
          proposedRevision: file.proposedRevision,
          appliedRevision: file.appliedRevision,
          beforeContent: file.beforeBytes.toString('utf8'),
          proposedContent: file.proposedBytes.toString('utf8'),
          ...(binaryImport === null ? {} : { binaryImport })
        }
      ]
    }
  }

  /**
   * Groups already-existing pending transactions into one review set
   * (Step 3 mixed binary+text grouping). Every transaction must be
   * pending, single-file, workspace-owned, and not already grouped —
   * otherwise nothing persists. Grouping is organizational only: each
   * child keeps individual Accept/Reject/Rollback, and there is still
   * no Accept All.
   */
  async groupTransactionsIntoSet(input: {
    workspaceId: number
    summary: string
    items: readonly { readonly transactionId: number; readonly fileSummary: string }[]
  }): Promise<ChangeSet> {
    if (!isValidId(input.workspaceId)) {
      throw new InvalidChangeSetRequestError('workspace reference is invalid')
    }
    if (typeof input.summary !== 'string' || input.summary.trim() === '') {
      throw new InvalidChangeSetRequestError('change-set summary is invalid')
    }
    if (input.items.length < 2 || input.items.length > MAX_GROUP_CHANGE_SET_FILES) {
      throw new InvalidChangeSetRequestError('change-set files are invalid')
    }
    const workspace = await requireLiveWorkspace(this.workspaces, input.workspaceId)
    const seen = new Set<number>()
    const links: { readonly transactionId: number; readonly ordinal: number; readonly fileSummary: string }[] = []
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index]
      if (item === undefined || !isValidId(item.transactionId)) {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      if (seen.has(item.transactionId)) {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      seen.add(item.transactionId)
      const header = this.transactions.findTransaction(item.transactionId)
      if (header === undefined || header.workspaceId !== workspace.id || header.status !== 'pending') {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      const files = this.transactions.findFiles(item.transactionId)
      if (files.length !== 1) {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      if (this.changeSets.findSetForTransaction(item.transactionId) !== undefined) {
        throw new InvalidChangeSetRequestError('change-set file is invalid')
      }
      links.push({ transactionId: item.transactionId, ordinal: index, fileSummary: validateFileSummary(item.fileSummary) })
    }
    const id = this.changeSets.createChangeSetForExisting(
      { workspaceId: workspace.id, kind: 'ai_multi_file_proposal', summary: input.summary.trim(), now: this.now() },
      links
    )
    return this.readPublicChangeSet(id)
  }

  private assemble(changeSetId: number): ChangeSet {
    const header = this.changeSets.findChangeSetById(changeSetId)
    if (header === undefined) {
      throw new ChangeSetNotFoundError()
    }
    this.requireExistingWorkspace(header.workspaceId)
    const links = this.changeSets.findItems(changeSetId)
    const items: ChangeSetItem[] = links.map((link) => {
      const tx = this.transactions.findTransaction(link.transactionId)
      if (tx === undefined) {
        throw new ChangeSetNotFoundError()
      }
      if (tx.workspaceId !== header.workspaceId) {
        throw new ChangeSetNotFoundError()
      }
      return {
        ordinal: link.ordinal,
        transaction: this.toPublicTransaction(tx, this.transactions.findFiles(tx.id)),
        fileSummary: link.fileSummary
      }
    })
    return {
      id: header.id,
      workspaceId: header.workspaceId,
      kind: header.kind as ChangeSetKind,
      summary: header.summary,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      items
    }
  }

  private readPublicChangeSet(changeSetId: number): ChangeSet {
    return this.assemble(changeSetId)
  }
}
