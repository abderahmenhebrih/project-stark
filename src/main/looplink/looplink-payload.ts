import { createHash } from 'node:crypto'
import { TextEncoder } from 'node:util'
import type { LooplinkPayloadV1 } from '../../shared/looplink/types'
import { LooplinkIntegrityError } from './looplink-errors'

const encoder = new TextEncoder()

/** Matches exactly 64 lowercase hex chars (a SHA-256 digest). */
const HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * Deterministically serializes a Looplink payload: fixed top-level
 * key order, arrays in caller order (already chronological/ordinal),
 * no whitespace, UTF-8 exact bytes. The builder owns the shape — the
 * renderer never submits payload JSON.
 */
export function serializeLooplinkPayload(payload: LooplinkPayloadV1): string {
  const ordered: Record<string, unknown> = {
    version: payload.version,
    source: { sessionId: payload.source.sessionId, title: payload.source.title },
    messages: payload.messages.map((entry) => ({ role: entry.role, content: entry.content, createdAt: entry.createdAt })),
    explicitContext: payload.explicitContext.map((entry) => ({
      kind: entry.kind,
      label: entry.label,
      relativePath: entry.relativePath,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      content: entry.content
    })),
    orchestration:
      payload.orchestration === null
        ? null
        : {
            status: payload.orchestration.status,
            action: payload.orchestration.action,
            planSummary: payload.orchestration.planSummary,
            workerResult: payload.orchestration.workerResult,
            workerResultOmitted: payload.orchestration.workerResultOmitted
          },
    changes: payload.changes.map((entry) => ({
      kind: entry.kind,
      transactionId: entry.transactionId,
      changeSetId: entry.changeSetId,
      relativePath: entry.relativePath,
      summary: entry.summary,
      status: entry.status,
      groupStatus: entry.groupStatus
    })),
    omissions: {
      messageCount: payload.omissions.messageCount,
      contextCount: payload.omissions.contextCount,
      workerResultOmitted: payload.omissions.workerResultOmitted,
      changeCount: payload.omissions.changeCount
    }
  }
  return JSON.stringify(ordered)
}

/** SHA-256 over the exact serialized payload bytes. */
export function hashLooplinkPayload(serialized: string): string {
  return createHash('sha256').update(encoder.encode(serialized)).digest('hex')
}

/** Exact UTF-8 byte size of the serialized payload. */
export function byteLengthOf(serialized: string): number {
  return encoder.encode(serialized).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parses and structurally validates a stored payload, then verifies
 * its hash. Returns the typed payload or throws a safe integrity
 * error — never raw JSON parse text.
 */
export function verifyLooplinkPayload(serialized: string, expectedHash: string): LooplinkPayloadV1 {
  if (!HASH_PATTERN.test(expectedHash)) {
    throw new LooplinkIntegrityError()
  }
  if (hashLooplinkPayload(serialized) !== expectedHash) {
    throw new LooplinkIntegrityError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new LooplinkIntegrityError()
  }
  if (!isRecord(parsed) || parsed['version'] !== 1) {
    throw new LooplinkIntegrityError()
  }
  return parsed as unknown as LooplinkPayloadV1
}
