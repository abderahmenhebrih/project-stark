import { MAX_ATTACHMENT_IMPORTS_PER_CALL } from '../attachment-import/limits'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'

/**
 * Strict validation for attachment_import tool arguments (Step 3).
 *
 * The model supplies ONLY opaque attachment IDs plus proposed
 * destinations — never source paths, storage paths, or absolute
 * paths. Shape and count are enforced here; destination safety,
 * session scope, and availability are enforced at execution time by
 * the import service. All violations collapse to the same invalid
 * tool-arguments error (never paths or internals).
 */

export interface ValidatedAttachmentImport {
  readonly attachmentId: string
  readonly proposedRelativePath: string
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

function isOpaqueAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

function parseOneImport(item: unknown): ValidatedAttachmentImport {
  if (!hasStrictShape(item, ['attachmentId', 'proposedRelativePath'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const record = item as Record<string, unknown>
  if (!isOpaqueAttachmentId(record['attachmentId'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const destination = record['proposedRelativePath']
  if (typeof destination !== 'string' || destination === '') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return { attachmentId: record['attachmentId'] as string, proposedRelativePath: destination }
}

/** Parses one attachment_import invocation (1–10 items, unique destinations). */
export function parseAttachmentImportArgs(args: unknown): { readonly imports: readonly ValidatedAttachmentImport[] } {
  if (!hasStrictShape(args, ['imports'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const raw = (args as Record<string, unknown>)['imports']
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ATTACHMENT_IMPORTS_PER_CALL) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const imports = raw.map(parseOneImport)
  const destinations = new Set<string>()
  for (const entry of imports) {
    if (destinations.has(entry.proposedRelativePath)) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    destinations.add(entry.proposedRelativePath)
  }
  return { imports }
}

/** Stable copy when imports are denied by workspace policy. */
export const WORKER_ATTACHMENT_IMPORT_DENY_MESSAGE = 'Attachment imports are not allowed by the workspace policy.'

/** Stable copy when the user denies creation of the import proposal. */
export const WORKER_ATTACHMENT_IMPORT_USER_DENY_MESSAGE = 'The user denied creation of the attachment import proposal.'

/** Stable copy when the referenced attachment cannot be imported. */
export const WORKER_ATTACHMENT_IMPORT_UNKNOWN_MESSAGE = 'Unknown or unavailable attachment import target.'

/**
 * Builds the exact human-readable approval summary for resolved
 * imports. Single: "Propose importing <name> to <destination>".
 * Multi: "Propose importing N chat attachments into the project".
 * Details list each resolved name plus destination, then the
 * explicit non-apply copy. No absolute paths, no store paths, no
 * IDs in the summary.
 */
export function buildAttachmentImportApprovalSummary(
  previews: readonly { readonly fileName: string; readonly destination: string }[]
): string {
  const header =
    previews.length === 1 && previews[0] !== undefined
      ? `Propose importing ${previews[0].fileName} to ${previews[0].destination}`
      : `Propose importing ${String(previews.length)} chat attachments into the project`
  const lines = previews.map((entry) => `${entry.fileName} → ${entry.destination}`)
  return (
    `${header}\n\n` +
    `Worker wants to propose copying chat attachments into the project.\n` +
    `Files:\n${lines.map((line) => `- ${line}`).join('\n')}\n\n` +
    `Approval creates a reviewable proposal only. It does not modify files. ` +
    `Files will not change until you review and Accept them.`
  )
}
