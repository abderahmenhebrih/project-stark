/**
 * Shared AI attachment capability contract (Step 2).
 *
 * ONE canonical, dependency-free heuristic for which provider models
 * can receive attachment content. Plain TypeScript only — no Node.js
 * or DOM APIs — so main and renderer share it without drift.
 *
 * This is a conservative local heuristic, never a provider claim: an
 * unknown model is treated as NOT vision-capable (fail closed with an
 * explicit capability error rather than silently dropping the image).
 * Renderer uses it for subtle inclusion states only; main re-evaluates
 * authoritatively before every provider call.
 */

import { hostedModelSupportsVision } from '../hosted-models/stark-model-map'

/** AI ingestion bound for one textual attachment (1 MiB of UTF-8). */
export const MAX_AI_TEXT_ATTACHMENT_BYTES = 1024 * 1024

/** AI ingestion bound for one image attachment (10 MiB, aligned with the inline-preview cap). */
export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Largest RAW image bytes (stored file size, not encoded length) that
 * may travel the STARK Free hosted inference route (`stark` provider
 * → `stark-infer` Edge Function).
 *
 * Exact derivation (so the bound stays honest — safety beats the
 * 100 KiB example: 100 KiB raw is REJECTED):
 * - Edge protocol caps: one message 160 KiB UTF-8, whole body 384 KiB
 *   (see supabase/functions/stark-infer/protocol.ts).
 * - 96 KiB raw = 98,304 bytes → base64 ceil(98304/3)*4 = 131,072
 *   bytes + `data:<mime>;base64,` prefix (22 bytes for image/png,
 *   23 for image/jpeg) ≈ 131,094 wire bytes for the image part.
 * - Base64 alphabet (A–Za–z0–9+/=) and the ASCII prefix need NO JSON
 *   escaping, so JSON wire bytes equal UTF-8 bytes here.
 * - 131,094 leaves ~32 KiB headroom inside one 160 KiB message for
 *   the attachment review block + trailing user text for the common
 *   small-text case. Larger user text, multiple images, or a larger
 *   total body can still overflow — the adapter's payload-aware
 *   backstop (measured on the serialized JSON body, not filesystem
 *   sizes) rejects those honestly; this per-image preflight is the
 *   conservative first gate, never the only gate.
 * - Human QA values (must agree everywhere): 64 KiB → sends,
 *   90 KiB → sends, 96 KiB (boundary) → sends, 100 KiB → clean
 *   hosted rejection (ImageTooLargeForHostedTransportError), never
 *   "Included". BYOK keeps the independent 10 MiB provider path.
 */
export const MAX_HOSTED_IMAGE_BYTES = 96 * 1024

/** Length of the `data:<mime>;base64,` prefix for one image part (UTF-8 bytes; prefix is ASCII). */
export function imageDataUrlPrefixBytes(mimeType: string): number {
  return new TextEncoder().encode(`data:${mimeType};base64,`).length
}

/** Estimated wire bytes of raw image bytes as a data-URL part. */
export function estimateImageTransportBytes(rawBytes: number, mimeType: string): number {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.ceil(rawBytes / 3) * 4 + imageDataUrlPrefixBytes(mimeType)
}

/** True when raw image bytes fit the hosted transport (fail closed on garbage). */
export function isImageTransportableForHosted(sizeBytes: unknown): boolean {
  return (
    typeof sizeBytes === 'number' &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= MAX_HOSTED_IMAGE_BYTES
  )
}

/** Most attachments included in one AI request (matches the per-message cap). */
export const MAX_AI_ATTACHMENT_COUNT = 10

/**
 * Total textual attachment content included in one AI request
 * (256 KiB). Individual files keep the 1 MiB ingestion bound, but the
 * aggregate is capped so attachments cannot blow the generation
 * context budget. Overflow files degrade to explicitly-labeled
 * metadata — never silent truncation.
 */
export const MAX_AI_ATTACHMENT_TOTAL_TEXT_BYTES = 256 * 1024

/**
 * Filename extensions eligible for bounded textual AI ingestion.
 * Conservative source/text formats only — never executables,
 * archives, or credential files.
 */
export const TEXT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  'txt',
  'text',
  'md',
  'markdown',
  'json',
  'jsonc',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'css',
  'html',
  'htm',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'sql',
  'sh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'hpp',
  'cpp',
  'cs',
  'swift',
  'kt',
  'kts',
  'vue',
  'svelte'
]

/** True when the stored filename has a text-ingestible extension. */
export function hasTextAttachmentExtension(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) {
    return false
  }
  return (TEXT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(filename.slice(dot + 1).toLowerCase())
}

/**
 * Conservative vision heuristic for known providers. The `openai`
 * BYOK provider matches its chat/vision families; the `stark` hosted
 * provider consults the evidence-based hosted model map. Every other
 * provider id is not vision-capable. Unknown model ids are not
 * vision-capable — callers surface an explicit capability error
 * instead of sending (or silently dropping) image bytes.
 */
export function modelSupportsVision(providerId: string, model: string): boolean {
  if (providerId === 'stark') {
    return hostedModelSupportsVision(model)
  }
  if (providerId !== 'openai') {
    return false
  }
  const id = model.toLowerCase()
  return (
    id.includes('gpt-4o') ||
    id.includes('gpt-4.1') ||
    id.includes('gpt-4-turbo') ||
    id.includes('gpt-4-vision') ||
    id.includes('gpt-5') ||
    id.includes('-vision') ||
    id.includes('computer-use') ||
    /(^|[^a-z0-9])o[1-9]([^0-9]|$)/.test(id)
  )
}

/** Renderer-facing inclusion state for one message attachment. */
export type AttachmentAiInclusion =
  | 'included-image'
  | 'included-text'
  | 'metadata-only'
  | 'unsupported'
  | 'route-too-large'

/**
 * Predicts how one attachment reaches the model under a given model
 * id. Metadata-only helper for subtle UI states — main enforces the
 * authoritative decision (with byte-level checks) before any call.
 *
 * `route-too-large` means the model could view the image but this
 * route cannot transport it (STARK Free hosted message/body caps):
 * callers must not claim inclusion and main fails early with an
 * explicit transport error instead of sending a doomed request.
 */
export function attachmentInclusionFor(
  providerId: string,
  model: string,
  attachment: { readonly kind: 'image' | 'file'; readonly name: string; readonly size: number }
): AttachmentAiInclusion {
  if (attachment.kind === 'image') {
    if (attachment.size > MAX_AI_IMAGE_BYTES) {
      return 'metadata-only'
    }
    if (!modelSupportsVision(providerId, model)) {
      return 'unsupported'
    }
    if (providerId === 'stark' && !isImageTransportableForHosted(attachment.size)) {
      return 'route-too-large'
    }
    return 'included-image'
  }
  if (hasTextAttachmentExtension(attachment.name) && attachment.size <= MAX_AI_TEXT_ATTACHMENT_BYTES) {
    return 'included-text'
  }
  return 'metadata-only'
}
