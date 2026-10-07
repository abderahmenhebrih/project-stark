import { createHash } from 'node:crypto'

/** Matches exactly 64 lowercase hex chars (a SHA-256 digest). */
const REVISION_PATTERN = /^[0-9a-f]{64}$/

/**
 * Calculates the stale-write revision for exact file bytes.
 *
 * Always hashes the ORIGINAL Buffer bytes — never decoded/re-encoded
 * content — so LF vs CRLF, Unicode normalization, and trailing newlines
 * each produce distinct revisions.
 */
export function hashFileBytes(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Runtime check for a renderer-supplied expected revision. */
export function isValidRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION_PATTERN.test(value)
}
