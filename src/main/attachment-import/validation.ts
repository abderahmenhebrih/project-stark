import { isAbsolute, sep } from 'node:path'
import { ATTACHMENT_ID_PATTERN } from '../chat-attachments/protocol'
import { MAX_REQUEST_PATH_LENGTH } from '../workspace-files/limits'
import { UnsafeAttachmentDestinationError } from './errors'

/**
 * Pure attachment-import validation (Step 3): proposed workspace
 * destinations are treated as hostile. No filesystem access here —
 * existence and symlink checks happen against the live workspace in
 * the service. Mirrors the Stage 6 lexical rules so import
 * destinations can never be more permissive than writer paths.
 */

/** True for a main-issued opaque attachment ID (32 lowercase hex). */
export function isValidImportAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_PATTERN.test(value)
}

function splitSegments(relativePath: string): string[] {
  const separator = sep === '\\' ? /[\\/]+/ : /\//
  return relativePath.split(separator)
}

/**
 * Lexically validates a proposed import destination. Rejects absolute
 * paths, drive/UNC prefixes, `..` anywhere (even paths that would
 * stay inside), NUL bytes, overlong input, empty/trailing-slash
 * (directory-like) forms, and the sensitive `.git` tree — before
 * touching the filesystem. Returns normalized `/`-joined segments.
 */
export function validateProposedDestination(destination: unknown): string {
  if (typeof destination !== 'string' || destination === '') {
    throw new UnsafeAttachmentDestinationError()
  }
  // NUL byte written as an escape on purpose: no raw control bytes in source.
  if (destination.includes('\0')) {
    throw new UnsafeAttachmentDestinationError()
  }
  if (destination.length > MAX_REQUEST_PATH_LENGTH) {
    throw new UnsafeAttachmentDestinationError()
  }
  if (isAbsolute(destination) || /^[A-Za-z]:/.test(destination) || destination.startsWith('\\\\')) {
    throw new UnsafeAttachmentDestinationError()
  }
  const segments = splitSegments(destination).filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) {
    throw new UnsafeAttachmentDestinationError()
  }
  for (const segment of segments) {
    if (segment === '..') {
      throw new UnsafeAttachmentDestinationError()
    }
  }
  if (segments[0] === '.git') {
    throw new UnsafeAttachmentDestinationError()
  }
  return segments.join('/')
}

/** One validated import item: opaque attachment ID plus safe destination. */
export interface ValidatedAttachmentImport {
  readonly attachmentId: string
  readonly destination: string
}

/**
 * Validates one Worker-supplied import item shape. Unknown extra
 * keys are rejected; source/storage/absolute paths can never pass
 * because only these two fields exist.
 */
export function validateImportItem(item: unknown): ValidatedAttachmentImport {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new UnsafeAttachmentDestinationError()
  }
  const record = item as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !('attachmentId' in record) || !('proposedRelativePath' in record)) {
    throw new UnsafeAttachmentDestinationError()
  }
  if (!isValidImportAttachmentId(record['attachmentId'])) {
    throw new UnsafeAttachmentDestinationError()
  }
  const destination = validateProposedDestination(record['proposedRelativePath'])
  return { attachmentId: record['attachmentId'] as string, destination }
}
