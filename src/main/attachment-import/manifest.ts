import { TextDecoder } from 'node:util'
import type { ChangeTransactionBinaryImport } from '../../shared/change-transactions/types'

/**
 * Binary-import manifest encoding (Step 3).
 *
 * Binary ADD proposals persist WITHOUT a schema migration: the
 * transaction file row stores an opaque UTF-8 manifest in
 * `proposed_bytes` (with `before_bytes` empty for the reviewed
 * absent checkpoint), reusing the existing v19 BLOB columns. The
 * manifest carries everything review needs — attachment ID, display
 * filename, destination, size, SHA-256 — and never an internal
 * store path. Pure encode/decode/detect helpers only: no
 * filesystem, no database, no providers.
 */

const MANIFEST_PREFIX = 'STARK-ATTACHMENT-IMPORT-v1\n'
const MANIFEST_VERSION = 1

export interface AttachmentImportManifest {
  readonly version: 1
  readonly attachmentId: string
  readonly fileName: string
  readonly destination: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly kind: 'image' | 'file'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isValidManifestShape(value: unknown): value is AttachmentImportManifest {
  if (!isRecord(value)) {
    return false
  }
  return (
    value['version'] === MANIFEST_VERSION &&
    typeof value['attachmentId'] === 'string' &&
    typeof value['fileName'] === 'string' &&
    typeof value['destination'] === 'string' &&
    typeof value['mimeType'] === 'string' &&
    typeof value['sizeBytes'] === 'number' &&
    Number.isInteger(value['sizeBytes']) &&
    (value['sizeBytes'] as number) >= 0 &&
    typeof value['sha256'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['sha256'] as string) &&
    (value['kind'] === 'image' || value['kind'] === 'file')
  )
}

/** Encodes one reviewed binary import as storable UTF-8 bytes. */
export function encodeAttachmentImportManifest(manifest: AttachmentImportManifest): Buffer {
  if (!isValidManifestShape(manifest)) {
    throw new Error('attachment import manifest is invalid')
  }
  return Buffer.from(`${MANIFEST_PREFIX}${JSON.stringify(manifest)}`, 'utf8')
}

/** True when stored proposed bytes carry a binary-import manifest. */
export function isAttachmentImportManifest(bytes: Buffer): boolean {
  return bytes.length > MANIFEST_PREFIX.length && bytes.subarray(0, MANIFEST_PREFIX.length).toString('utf8') === MANIFEST_PREFIX
}

/** Decodes stored proposed bytes into a manifest, or null when absent/corrupt. */
export function decodeAttachmentImportManifest(bytes: Buffer): AttachmentImportManifest | null {
  if (!isAttachmentImportManifest(bytes)) {
    return null
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(MANIFEST_PREFIX.length))
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  return isValidManifestShape(parsed) ? parsed : null
}

/**
 * Renderer-safe review metadata for one stored binary-import file
 * row. Returns null for non-binary rows. The raw manifest JSON is
 * never surfaced — the renderer renders an asset card from this.
 */
export function binaryImportPublicInfo(proposedBytes: Buffer): ChangeTransactionBinaryImport | null {
  const manifest = decodeAttachmentImportManifest(proposedBytes)
  if (manifest === null) {
    return null
  }
  return {
    attachmentId: manifest.attachmentId,
    fileName: manifest.fileName,
    destination: manifest.destination,
    mimeType: manifest.mimeType,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    kind: manifest.kind
  }
}
