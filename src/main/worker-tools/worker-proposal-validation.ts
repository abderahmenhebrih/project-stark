import { TextEncoder } from 'node:util'
import { InvalidWorkerToolRequestError } from './worker-tool-errors'
import {
  MAX_WORKER_PROPOSAL_CHANGES,
  MAX_WORKER_PROPOSAL_FILE_BYTES,
  MAX_WORKER_PROPOSAL_FILE_SUMMARY_CODEPOINTS,
  MAX_WORKER_PROPOSAL_TOTAL_BYTES
} from './worker-tool-limits'
import { isValidReadRefFormat } from './worker-read-ref'

const encoder = new TextEncoder()

/** One validated requested file change (target authority still unresolved). */
export interface ValidatedProposalChange {
  readonly targetRef: string
  readonly summary: string
  readonly proposedContent: string
}

function countCodePoints(value: string): number {
  return [...value].length
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
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

function validateSummary(summary: unknown): string {
  if (typeof summary !== 'string') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const trimmed = summary.trim()
  if (trimmed === '') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (trimmed.includes('\0')) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (hasUnpairedSurrogate(trimmed)) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (countCodePoints(trimmed) > MAX_WORKER_PROPOSAL_FILE_SUMMARY_CODEPOINTS) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return trimmed
}

function validateProposedContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (content === '') {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (content.includes('\0')) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (hasUnpairedSurrogate(content)) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  if (encoder.encode(content).byteLength > MAX_WORKER_PROPOSAL_FILE_BYTES) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return content
}

/**
 * Strict main-owned validation for change_propose arguments.
 * Exactly {changes:[{targetRef,summary,proposedContent}]} with 1–5
 * items, unique targetRefs, per-file 64 KiB, total 192 KiB, 300-cp
 * summaries. Rejects extra fields, model-controlled paths,
 * revisions, and transaction references. Throws
 * InvalidWorkerToolRequestError for any violation.
 */
export function parseChangeProposeArgs(args: unknown): { readonly changes: readonly ValidatedProposalChange[] } {
  if (!hasStrictShape(args, ['changes'])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const changes = record['changes']
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_WORKER_PROPOSAL_CHANGES) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  const seen = new Set<string>()
  const validated: ValidatedProposalChange[] = []
  let totalBytes = 0
  for (const entry of changes) {
    if (!hasStrictShape(entry, ['proposedContent', 'summary', 'targetRef'])) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    const item = entry as Record<string, unknown>
    const targetRef = item['targetRef']
    if (!isValidReadRefFormat(targetRef)) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    if (seen.has(targetRef)) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    seen.add(targetRef)
    const summary = validateSummary(item['summary'])
    const proposedContent = validateProposedContent(item['proposedContent'])
    totalBytes += encoder.encode(proposedContent).byteLength
    if (totalBytes > MAX_WORKER_PROPOSAL_TOTAL_BYTES) {
      throw new InvalidWorkerToolRequestError('tool arguments are invalid')
    }
    validated.push({ targetRef, summary, proposedContent })
  }
  return { changes: validated }
}

/** Canonical stale copy shown to the Worker (bounded, no paths). */
export const WORKER_PROPOSAL_STALE_MESSAGE =
  'The file changed after STARK read it. Read it again before proposing a change.'

/** Canonical deny-policy copy for change.propose. */
export const WORKER_PROPOSAL_DENY_MESSAGE = 'Change proposals are not allowed for this Workspace.'

/** Canonical user-deny copy after proposal approval denial. */
export const WORKER_PROPOSAL_USER_DENY_MESSAGE = 'The user denied creation of this code proposal.'

/** Canonical unknown-target copy (no path guessing). */
export const WORKER_PROPOSAL_UNKNOWN_TARGET_MESSAGE =
  'Unknown or invalid proposal target. Read the file with workspace_read in this run before proposing a change.'
