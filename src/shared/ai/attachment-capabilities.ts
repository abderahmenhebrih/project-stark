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

/** AI ingestion bound for one textual attachment (1 MiB of UTF-8). */
export const MAX_AI_TEXT_ATTACHMENT_BYTES = 1024 * 1024

/** AI ingestion bound for one image attachment (10 MiB, aligned with the inline-preview cap). */
export const MAX_AI_IMAGE_BYTES = 10 * 1024 * 1024

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
 * Conservative vision heuristic for known providers. Only the
 * `openai` provider exists in STARK v1; every other provider id is
 * not vision-capable. Unknown model ids are not vision-capable —
 * callers surface an explicit capability error instead of sending
 * (or silently dropping) image bytes.
 */
export function modelSupportsVision(providerId: string, model: string): boolean {
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

/**
 * Predicts how one attachment reaches the model under a given model
 * id. Metadata-only helper for subtle UI states — main enforces the
 * authoritative decision (with byte-level checks) before any call.
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
    return modelSupportsVision(providerId, model) ? 'included-image' : 'unsupported'
  }
  if (hasTextAttachmentExtension(attachment.name) && attachment.size <= MAX_AI_TEXT_ATTACHMENT_BYTES) {
    return 'included-text'
  }
  return 'metadata-only'
}
