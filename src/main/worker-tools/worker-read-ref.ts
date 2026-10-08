import { TextEncoder } from 'node:util'
import { isValidRevision } from '../workspace-files/file-revision'
import { MAX_REQUEST_PATH_LENGTH } from '../workspace-files/limits'
import { MAX_WORKER_READ_BYTES } from './worker-tool-limits'

const encoder = new TextEncoder()

const READ_REF_PATTERN = /^R[1-9][0-9]*$/

/** Deterministic per-run opaque reference: R1, R2, … (1-indexed). */
export function readRefForIndex(index: number): string {
  return `R${String(index)}`
}

/** True for syntactically valid readRef strings (R1, R2, …). */
export function isValidReadRefFormat(value: unknown): value is string {
  return typeof value === 'string' && READ_REF_PATTERN.test(value)
}

/** Strictly decoded successful workspace_read payload (main-owned, never trusted blindly). */
export interface DecodedReadPayload {
  readonly readRef: string
  readonly relativePath: string
  readonly content: string
  readonly revision: string
  readonly bytes: number
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

/**
 * Parses one persisted successful workspace_read result payload
 * through a strict main-owned decoder. Returns undefined for any
 * malformed, tampered, or legacy (ref-less) payload — callers treat
 * that as failed proposal authority, never as filesystem truth.
 */
export function decodeSuccessfulReadPayload(payload: unknown): DecodedReadPayload | undefined {
  if (typeof payload !== 'string' || payload === '') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  if (!hasExactKeys(record, ['bytes', 'content', 'readRef', 'relativePath', 'revision'])) {
    return undefined
  }
  const { readRef, relativePath, content, revision, bytes } = record
  if (!isValidReadRefFormat(readRef)) {
    return undefined
  }
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.length > MAX_REQUEST_PATH_LENGTH) {
    return undefined
  }
  if (typeof content !== 'string') {
    return undefined
  }
  if (!isValidRevision(revision)) {
    return undefined
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return undefined
  }
  const actual = encoder.encode(content).byteLength
  if (actual !== bytes) {
    return undefined
  }
  if (bytes > MAX_WORKER_READ_BYTES) {
    return undefined
  }
  return { readRef, relativePath, content, revision, bytes }
}

/** Minimal stored-event view needed for readRef resolution (no secrets). */
export interface ReadRefEventView {
  readonly toolName: string
  readonly status: string
  readonly payload: string
  readonly workspaceId?: number
  readonly sessionId?: number
}

/**
 * Builds the deterministic same-run readRef map from persisted tool
 * events (insertion order). Only succeeded workspace_read events with
 * strictly valid payloads participate. Duplicate refs invalidate the
 * whole map (tamper signal) — callers fail the proposal safely.
 */
export function buildReadRefMap(events: readonly ReadRefEventView[]): Map<string, DecodedReadPayload> | undefined {
  const map = new Map<string, DecodedReadPayload>()
  for (const event of events) {
    if (event.toolName !== 'workspace_read' || event.status !== 'succeeded') {
      continue
    }
    const decoded = decodeSuccessfulReadPayload(event.payload)
    if (decoded === undefined) {
      continue
    }
    if (map.has(decoded.readRef)) {
      return undefined
    }
    map.set(decoded.readRef, decoded)
  }
  return map
}

/**
 * Next deterministic ref for one run: one plus the number of already
 * persisted successful workspace_read events. Naturally bounded by the
 * four-tool budget. Denied/failed reads never allocate refs.
 */
export function nextReadRef(events: readonly ReadRefEventView[]): string {
  let count = 0
  for (const event of events) {
    if (event.toolName === 'workspace_read' && event.status === 'succeeded') {
      const decoded = decodeSuccessfulReadPayload(event.payload)
      if (decoded !== undefined) {
        count += 1
      } else {
        // Legacy or tampered payload without a valid ref still consumed
        // a successful read slot; count it to keep refs deterministic
        // and non-repeating within the run.
        count += 1
      }
    }
  }
  return readRefForIndex(count + 1)
}
