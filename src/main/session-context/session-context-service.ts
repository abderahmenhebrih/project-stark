import { TextEncoder } from 'node:util'
import type {
  FileSessionContextDraft,
  ManualNoteSessionContextDraft,
  SessionContextDraft,
  SessionContextKind
} from '../../shared/context/types'
import type { NewMessageContext } from '../database/repositories/coding-session-repository'
import type { WorkspaceFilesService } from '../workspace-files/workspace-files-service'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'
import { isValidRevision } from '../workspace-files/file-revision'
import {
  FileTooLargeError,
  UnsupportedFileError,
  WorkspaceEntryTypeError,
  WorkspaceFilesError,
  WorkspacePathNotFoundError,
  WorkspacePathOutsideRootError
} from '../workspace-files/errors'
import { InvalidWorkspaceError } from '../workspace/errors'
import {
  ContextFileUnavailableError,
  ContextItemTooLargeError,
  InvalidContextRangeError,
  InvalidContextRequestError,
  StaleContextError,
  TooManyContextItemsError,
  TotalContextTooLargeError,
  UnsupportedContextFileError
} from './errors'
import {
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_ITEM_BYTES,
  MAX_CONTEXT_LABEL_CODEPOINTS,
  MAX_MANUAL_NOTE_BYTES,
  MAX_TOTAL_CONTEXT_BYTES,
  SEARCH_MATCH_CONTEXT_RADIUS
} from './limits'
import { joinLines, sliceLines, splitLines, windowAroundLine } from './extract-file-context'
import { validateUserMessageContent } from '../sessions/message-validation'
import { InvalidSessionMessageError, SessionMessageTooLargeError } from '../sessions/errors'

const encoder = new TextEncoder()

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function countCodePoints(value: string): number {
  return [...value].length
}

const VALID_KINDS: readonly SessionContextKind[] = ['file-excerpt', 'whole-file', 'search-match', 'manual-note']

const FILE_ATTACHMENT_KEYS: readonly string[] = [
  'draftId',
  'kind',
  'label',
  'relativePath',
  'lineStart',
  'lineEnd',
  'content',
  'contentBytes',
  'sourceRevision'
]

const NOTE_ATTACHMENT_KEYS: readonly string[] = [
  'draftId',
  'kind',
  'label',
  'relativePath',
  'lineStart',
  'lineEnd',
  'content',
  'contentBytes'
]

function isValidLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * Validates a draft label: trimmed, non-empty, bounded, single-line,
 * NUL-free. Used for both renderer-supplied and main-derived labels.
 */
export function validateContextLabel(label: unknown, fallback: string): string {
  if (typeof label !== 'string' || label.trim() === '') {
    return fallback
  }
  const trimmed = label.trim()
  if (trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new InvalidContextRequestError('context label is invalid')
  }
  if (countCodePoints(trimmed) > MAX_CONTEXT_LABEL_CODEPOINTS) {
    throw new InvalidContextRequestError('context label is too long')
  }
  return trimmed
}

function enforceItemBytes(content: string): number {
  const bytes = encoder.encode(content).byteLength
  if (bytes > MAX_CONTEXT_ITEM_BYTES) {
    throw new ContextItemTooLargeError()
  }
  return bytes
}

/** Maps workspace-files read failures to context-domain errors. */
function mapFileReadError(error: unknown): never {
  if (error instanceof WorkspacePathNotFoundError) {
    throw new ContextFileUnavailableError({ cause: error })
  }
  if (error instanceof UnsupportedFileError) {
    throw new UnsupportedContextFileError({ cause: error })
  }
  if (error instanceof FileTooLargeError) {
    throw new ContextItemTooLargeError()
  }
  if (
    error instanceof WorkspacePathOutsideRootError ||
    error instanceof WorkspaceEntryTypeError ||
    error instanceof InvalidWorkspaceError
  ) {
    throw new InvalidContextRequestError('context file reference is invalid')
  }
  if (error instanceof WorkspaceFilesError) {
    throw new ContextFileUnavailableError({ cause: error })
  }
  throw error
}

/**
 * Explicit project-context domain service (Stage 15, pinned in 15B).
 *
 * Prepare methods read workspace files through the existing trusted
 * Stage 6 flow and return preview drafts pinned to the exact on-disk
 * SHA-256 revision (Stage 8 mechanism). At send time every file-based
 * draft is re-read and its current revision compared against the
 * reviewed `sourceRevision`: a mismatch fails the whole send with a
 * controlled stale-context error — never a silent substitution, never
 * a partial persist. Renderer-supplied file content is preview-only
 * and never trusted; only manual-note text originates from the
 * renderer (validated like message text). No network, no provider, no
 * AI concerns here — formatting for the provider is a pure function
 * (`formatProviderContext`).
 */
export class SessionContextService {
  private draftCounter = 0

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly files: WorkspaceFilesService
  ) {}

  private nextDraftId(): string {
    this.draftCounter += 1
    return `ctx-${this.draftCounter}`
  }

  private requireWorkspace(workspaceId: number): void {
    if (this.workspaces.findById(workspaceId) === undefined) {
      throw new InvalidContextRequestError('workspace reference is invalid')
    }
  }

  private async readFileText(
    workspaceId: number,
    relativePath: unknown
  ): Promise<{ content: string; path: string; revision: string }> {
    if (typeof relativePath !== 'string') {
      throw new InvalidContextRequestError('context file reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    try {
      const file = await this.files.readTextFile({ workspaceId, relativePath })
      return { content: file.content, path: file.relativePath, revision: file.revision }
    } catch (error) {
      return mapFileReadError(error)
    }
  }

  private makeFileDraft(
    kind: FileSessionContextDraft['kind'],
    label: string,
    relativePath: string,
    lineStart: number,
    lineEnd: number,
    content: string,
    sourceRevision: string
  ): FileSessionContextDraft {
    return {
      draftId: this.nextDraftId(),
      kind,
      label,
      relativePath,
      lineStart,
      lineEnd,
      content,
      contentBytes: enforceItemBytes(content),
      sourceRevision
    }
  }

  private makeNoteDraft(label: string, content: string): ManualNoteSessionContextDraft {
    return {
      draftId: this.nextDraftId(),
      kind: 'manual-note',
      label,
      relativePath: null,
      lineStart: null,
      lineEnd: null,
      content,
      contentBytes: enforceItemBytes(content)
    }
  }

  /** Prepares an explicit line-range excerpt from a workspace text file. */
  async prepareExcerpt(payload: unknown): Promise<SessionContextDraft> {
    if (!hasStrictShape(payload, ['workspaceId', 'relativePath', 'lineStart', 'lineEnd'])) {
      throw new InvalidContextRequestError('context excerpt request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, relativePath, lineStart, lineEnd } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidContextRequestError('workspace reference is invalid')
    }
    if (!isValidLineNumber(lineStart) || !isValidLineNumber(lineEnd) || (lineEnd as number) < (lineStart as number)) {
      throw new InvalidContextRangeError()
    }
    const { content, path, revision } = await this.readFileText(workspaceId, relativePath)
    const lines = sliceLines(content, lineStart as number, lineEnd as number)
    const actualEnd = Math.min(lineEnd as number, splitLines(content).length)
    return this.makeFileDraft(
      'file-excerpt',
      `${path} · lines ${String(lineStart)}–${String(actualEnd)}`,
      path,
      lineStart as number,
      actualEnd,
      joinLines(lines),
      revision
    )
  }

  /** Prepares a whole workspace text file (bounded by the item cap). */
  async prepareWholeFile(payload: unknown): Promise<SessionContextDraft> {
    if (!hasStrictShape(payload, ['workspaceId', 'relativePath'])) {
      throw new InvalidContextRequestError('context file request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, relativePath } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidContextRequestError('workspace reference is invalid')
    }
    const { content, path, revision } = await this.readFileText(workspaceId, relativePath)
    const lineCount = splitLines(content).length
    return this.makeFileDraft('whole-file', `${path} · whole file`, path, 1, lineCount, content, revision)
  }

  /** Prepares the excerpt window around one search-match line. */
  async prepareSearchMatch(payload: unknown): Promise<SessionContextDraft> {
    if (!hasStrictShape(payload, ['workspaceId', 'relativePath', 'line'])) {
      throw new InvalidContextRequestError('context search-match request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, relativePath, line } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidContextRequestError('workspace reference is invalid')
    }
    if (!isValidLineNumber(line)) {
      throw new InvalidContextRangeError()
    }
    const { content, path, revision } = await this.readFileText(workspaceId, relativePath)
    const window = windowAroundLine(content, line as number, SEARCH_MATCH_CONTEXT_RADIUS)
    return this.makeFileDraft(
      'search-match',
      `${path} · line ${String(line)}`,
      path,
      window.lineStart,
      window.lineEnd,
      joinLines(window.lines),
      revision
    )
  }

  /** Prepares a manual note. The only renderer-originated content. */
  async prepareNote(payload: unknown): Promise<SessionContextDraft> {
    if (!hasStrictShape(payload, ['workspaceId', 'label', 'content'])) {
      throw new InvalidContextRequestError('context note request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, label, content } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidContextRequestError('workspace reference is invalid')
    }
    this.requireWorkspace(workspaceId)
    let validated: string
    try {
      validated = validateUserMessageContent(content)
    } catch (error) {
      if (error instanceof InvalidSessionMessageError || error instanceof SessionMessageTooLargeError) {
        throw new InvalidContextRequestError('context note text is invalid')
      }
      throw error
    }
    if (encoder.encode(validated).byteLength > MAX_MANUAL_NOTE_BYTES) {
      throw new ContextItemTooLargeError()
    }
    const finalLabel = label === undefined ? 'Manual note' : validateContextLabel(label, 'Manual note')
    return this.makeNoteDraft(finalLabel, validated)
  }

  /**
   * Resolves send-time attachments into persistable rows. Every
   * file-based draft is re-read from disk and its current SHA-256
   * compared against the reviewed `sourceRevision`; any mismatch
   * fails the entire send with `StaleContextError` before anything
   * is persisted. Vanished files fail the send; manual-note content
   * is re-validated. Enforces count and total byte budgets — never
   * truncates silently.
   */
  async resolveAttachmentsForSend(
    workspaceId: number,
    drafts: unknown,
    now: number
  ): Promise<NewMessageContext[]> {
    if (drafts === undefined) {
      return []
    }
    if (!Array.isArray(drafts)) {
      throw new InvalidContextRequestError('context attachments are invalid')
    }
    if (drafts.length > MAX_CONTEXT_ITEMS) {
      throw new TooManyContextItemsError()
    }
    const resolved: NewMessageContext[] = []
    for (const draft of drafts) {
      resolved.push(await this.resolveOneAttachment(workspaceId, draft, now))
    }
    let total = 0
    for (const item of resolved) {
      total += item.contentBytes
    }
    if (total > MAX_TOTAL_CONTEXT_BYTES) {
      throw new TotalContextTooLargeError()
    }
    return resolved
  }

  private async resolveOneAttachment(workspaceId: number, draft: unknown, now: number): Promise<NewMessageContext> {
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
      throw new InvalidContextRequestError('context attachment is invalid')
    }
    const kind = (draft as Record<string, unknown>)['kind']
    if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as SessionContextDraft['kind'])) {
      throw new InvalidContextRequestError('context attachment kind is invalid')
    }
    const contextKind = kind as SessionContextDraft['kind']
    if (contextKind === 'manual-note') {
      if (!hasStrictShape(draft, NOTE_ATTACHMENT_KEYS)) {
        throw new InvalidContextRequestError('context attachment is invalid')
      }
      const record = draft as Record<string, unknown>
      let validated: string
      try {
        validated = validateUserMessageContent(record['content'])
      } catch (error) {
        if (error instanceof InvalidSessionMessageError || error instanceof SessionMessageTooLargeError) {
          throw new InvalidContextRequestError('context note text is invalid')
        }
        throw error
      }
      if (encoder.encode(validated).byteLength > MAX_MANUAL_NOTE_BYTES) {
        throw new ContextItemTooLargeError()
      }
      const label = validateContextLabel(record['label'], 'Manual note')
      const bytes = enforceItemBytes(validated)
      return { kind: contextKind, label, relativePath: null, lineStart: null, lineEnd: null, content: validated, contentBytes: bytes, createdAt: now }
    }
    // File-based items: main authority is workspaceId + relativePath +
    // range + sourceRevision. Submitted preview content/contentBytes are
    // display-only and never trusted.
    if (!hasStrictShape(draft, FILE_ATTACHMENT_KEYS)) {
      throw new InvalidContextRequestError('context attachment is invalid')
    }
    const record = draft as Record<string, unknown>
    const sourceRevision = record['sourceRevision']
    if (!isValidRevision(sourceRevision)) {
      throw new InvalidContextRequestError('context attachment is invalid')
    }
    const relativePath = record['relativePath']
    if (typeof relativePath !== 'string') {
      throw new InvalidContextRequestError('context file reference is invalid')
    }
    const { content, path, revision: currentRevision } = await this.readFileText(workspaceId, relativePath)
    if (currentRevision !== sourceRevision) {
      throw new StaleContextError()
    }
    if (kind === 'whole-file') {
      const label = validateContextLabel(record['label'], `${path} · whole file`)
      const bytes = enforceItemBytes(content)
      return {
        kind: contextKind,
        label,
        relativePath: path,
        lineStart: 1,
        lineEnd: splitLines(content).length,
        content,
        contentBytes: bytes,
        createdAt: now
      }
    }
    const lineStart = record['lineStart']
    const lineEnd = record['lineEnd']
    if (!isValidLineNumber(lineStart) || !isValidLineNumber(lineEnd) || (lineEnd as number) < (lineStart as number)) {
      throw new InvalidContextRangeError()
    }
    // Both excerpt and search-match reconstruct by slicing the validated
    // original range from the revision-pinned bytes. Because the revision
    // matches, this must equal what the user reviewed. Search-match must
    // NOT recompute a ±3 window around a new anchor — the stored
    // lineStart/lineEnd already are the reviewed window.
    const lines = sliceLines(content, lineStart as number, lineEnd as number)
    const actualEnd = Math.min(lineEnd as number, splitLines(content).length)
    const fallback =
      kind === 'search-match'
        ? `${path} · line ${String(lineStart)}`
        : `${path} · lines ${String(lineStart)}–${String(actualEnd)}`
    const label = validateContextLabel(record['label'], fallback)
    const joined = joinLines(lines)
    const bytes = enforceItemBytes(joined)
    return {
      kind: contextKind,
      label,
      relativePath: path,
      lineStart: lineStart as number,
      lineEnd: actualEnd,
      content: joined,
      contentBytes: bytes,
      createdAt: now
    }
  }
}

/**
 * Formats attached items into the deterministic provider context
 * block. Pure and side-effect free. Only actually-sent items are
 * ever passed in — no hidden workspace content by construction.
 */
export function formatProviderContext(
  items: readonly {
    readonly kind: SessionContextKind
    readonly label: string
    readonly relativePath: string | null
    readonly lineStart: number | null
    readonly lineEnd: number | null
    readonly content: string
  }[]
): string {
  return items
    .map((item, index) => {
      const header = `[CONTEXT ${String(index + 1)}]`
      const typeLine = `Type: ${item.kind}`
      const pathLine =
        item.relativePath !== null
          ? `Path: ${item.relativePath}\nLines: ${String(item.lineStart ?? '')}-${String(item.lineEnd ?? '')}`
          : `Label: ${item.label}`
      return `${header}\n${typeLine}\n${pathLine}\nContent:\n${item.content}`
    })
    .join('\n\n')
}
