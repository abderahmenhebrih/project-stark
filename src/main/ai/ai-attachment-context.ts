import {
  MAX_AI_ATTACHMENT_COUNT,
  MAX_AI_ATTACHMENT_TOTAL_TEXT_BYTES,
  MAX_AI_IMAGE_BYTES,
  MAX_AI_TEXT_ATTACHMENT_BYTES,
  hasTextAttachmentExtension,
  modelSupportsVision
} from '../../shared/ai/attachment-capabilities'

/**
 * Normalized AI-facing attachment representation (Step 2).
 *
 * Metadata only — never bytes, never filesystem paths. Provider
 * adapters receive actual content separately and only after
 * capability and size checks. Ordering matches the message link
 * order so multi-attachment requests preserve user intent.
 */
export interface AiAttachment {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly kind: 'image' | 'file'
  /** What the model is allowed to receive for this attachment. */
  readonly contentCapability: 'image' | 'text' | 'metadata-only'
}

/**
 * Explicit per-model attachment capabilities (Step 2). Providers
 * differ — adapters must consult this before touching bytes, and
 * must never send unsupported attachments silently.
 */
export interface ProviderAttachmentCapabilities {
  readonly supportsImages: boolean
  readonly supportsDocuments: boolean
  readonly supportsTextAttachments: boolean
  readonly supportsMultipleImages: boolean
  readonly maxImageBytes: number
  readonly maxAttachmentCount: number
}

/**
 * Derives the attachment capabilities for one provider model. Only
 * the `openai` provider exists in v1: vision-capable families accept
 * images (bounded), text attachments are bounded text, and native
 * binary documents (PDF/office/archives) are metadata-only in this
 * pass — no ad-hoc parsers, no OCR.
 */
export function capabilitiesForModel(providerId: string, model: string): ProviderAttachmentCapabilities {
  const vision = modelSupportsVision(providerId, model)
  return {
    supportsImages: vision,
    supportsDocuments: false,
    supportsTextAttachments: true,
    supportsMultipleImages: vision,
    maxImageBytes: MAX_AI_IMAGE_BYTES,
    maxAttachmentCount: MAX_AI_ATTACHMENT_COUNT
  }
}

/** True when image bytes for the trailing message require vision. */
export function attachmentsNeedVision(
  rows: readonly { readonly kind: 'image' | 'file'; readonly size: number }[]
): boolean {
  return rows.some((row) => row.kind === 'image' && row.size <= MAX_AI_IMAGE_BYTES)
}

export interface AiAttachmentPlan {
  readonly attachments: readonly AiAttachment[]
  /** Total textual bytes the resolver may ingest for this request. */
  readonly textBudgetBytes: number
}

/**
 * Builds the normalized AI attachment plan from committed message
 * link rows (stored metadata only — never renderer-supplied MIME).
 * Preserves ordering. Throws an explicit capability error when the
 * model cannot accept the set (never silently discards).
 *
 * `visionMode` controls image handling for non-vision models:
 * - `require` (Ask, Worker): throws VisionUnsupportedForModelError so
 *   the user gets an explicit capability error
 * - `describe` (Brain plan): degrades images to explicitly-labeled
 *   metadata so planning can continue on the fixed Brain assignment
 *   while a vision-capable Worker still receives the bytes
 */
export function planAiAttachments(input: {
  rows: readonly {
    readonly attachmentId: string
    readonly originalName: string
    readonly mimeType: string
    readonly sizeBytes: number
    readonly kind: 'image' | 'file'
  }[]
  capabilities: ProviderAttachmentCapabilities
  visionMode?: 'require' | 'describe'
}): AiAttachmentPlan {
  const visionMode = input.visionMode ?? 'require'
  if (input.rows.length > input.capabilities.maxAttachmentCount) {
    throw new TooManyAttachmentsForModelError()
  }
  const images = input.rows.filter((row) => row.kind === 'image')
  if (images.length > 0 && !input.capabilities.supportsImages && visionMode === 'require') {
    throw new VisionUnsupportedForModelError()
  }
  if (images.length > 1 && !input.capabilities.supportsMultipleImages && visionMode === 'require') {
    throw new VisionUnsupportedForModelError()
  }
  for (const row of images) {
    if (row.sizeBytes > input.capabilities.maxImageBytes && (input.capabilities.supportsImages || visionMode === 'require')) {
      throw new AttachmentTooLargeForModelError()
    }
  }
  const imagesAsMetadata = images.length > 0 && !input.capabilities.supportsImages
  const attachments = input.rows.map((row): AiAttachment => {
    if (row.kind === 'image') {
      return {
        id: row.attachmentId,
        name: row.originalName,
        mimeType: row.mimeType,
        size: row.sizeBytes,
        kind: row.kind,
        contentCapability: imagesAsMetadata ? 'metadata-only' : 'image'
      }
    }
    const textEligible =
      input.capabilities.supportsTextAttachments &&
      hasTextAttachmentExtension(row.originalName) &&
      row.sizeBytes <= MAX_AI_TEXT_ATTACHMENT_BYTES
    return {
      id: row.attachmentId,
      name: row.originalName,
      mimeType: row.mimeType,
      size: row.sizeBytes,
      kind: row.kind,
      contentCapability: textEligible ? 'text' : 'metadata-only'
    }
  })
  return { attachments, textBudgetBytes: MAX_AI_ATTACHMENT_TOTAL_TEXT_BYTES }
}

/** One reviewed inclusion line: what the model actually receives. */
export interface AiAttachmentReviewLine {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly included: boolean
  readonly inclusionNote: string
}

function formatByteSize(size: number): string {
  if (size < 1024) {
    return `${String(size)} B`
  }
  if (size < 1024 * 1024) {
    return `${String(Math.round(size / 1024))} KB`
  }
  return `${String(Math.round((size / (1024 * 1024)) * 10) / 10)} MB`
}

/**
 * Deterministic review block for the provider-bound attachment
 * section (Stage 15 invariant: what you reviewed is what the model
 * received). Built from the same committed rows the resolver
 * ingests, plus the resolver's per-attachment outcome. The block
 * travels as a separate user-role message — attachment content is
 * untrusted user data and is never interpolated into developer
 * instructions.
 */
export function formatAiAttachmentReviewBlock(lines: readonly AiAttachmentReviewLine[]): string {
  const body = lines
    .map((line, index) => {
      const header = `[ATTACHMENT ${String(index + 1)}]`
      return `${header} id: ${line.id} name: ${line.name} ${line.detail} — ${line.inclusionNote}`
    })
    .join('\n')
  return `[ATTACHMENTS ${String(lines.length)}]\n${body}`
}

/** Builds review lines from the plan plus resolver outcomes. */
export function buildAiAttachmentReviewLines(input: {
  plan: readonly AiAttachment[]
  outcomes: ReadonlyMap<string, { readonly included: boolean; readonly note: string }>
}): AiAttachmentReviewLine[] {
  return input.plan.map((attachment) => {
    const outcome = input.outcomes.get(attachment.id)
    const detail =
      attachment.contentCapability === 'image'
        ? `Image · ${attachment.mimeType} · ${formatByteSize(attachment.size)}`
        : attachment.contentCapability === 'text'
          ? `Text · ${attachment.mimeType} · ${formatByteSize(attachment.size)}`
          : `${attachment.kind === 'image' ? 'Image' : 'File'} · ${attachment.mimeType} · ${formatByteSize(attachment.size)}`
    if (outcome === undefined) {
      return {
        id: attachment.id,
        name: attachment.name,
        detail,
        included: false,
        inclusionNote: 'content not included'
      }
    }
    return {
      id: attachment.id,
      name: attachment.name,
      detail,
      included: outcome.included,
      inclusionNote: outcome.note
    }
  })
}

/**
 * Worker relevance gate (Step 2 §10): attachment blobs reach a Worker
 * only when explicitly relevant to the delegated task. The Brain's
 * worker instruction (or the user request) must reference attachments
 * generally or name one of the attached files; otherwise the Worker
 * receives metadata only.
 */
export function workerAttachmentsRelevant(input: {
  workerInstruction: string
  userRequest: string
  attachments: readonly { readonly name: string }[]
}): boolean {
  const haystack = `${input.workerInstruction}\n${input.userRequest}`.toLowerCase()
  if (input.attachments.length === 0) {
    return false
  }
  const generic = ['attach', 'image', 'picture', 'photo', 'screenshot', 'logo', 'hero', 'banner', 'asset', 'file:', 'the file']
  if (generic.some((marker) => haystack.includes(marker))) {
    return true
  }
  return input.attachments.some((attachment) => {
    const base = attachment.name.toLowerCase().split(/[/\\]/).pop() ?? ''
    return base !== '' && haystack.includes(base)
  })
}

// --- Capability errors (safe normalized copy, no paths/stacks). ---

export class AttachmentCapabilityError extends Error {
  override readonly name: string = 'AttachmentCapabilityError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** The selected model cannot view image attachments. */
export class VisionUnsupportedForModelError extends AttachmentCapabilityError {
  override readonly name: string = 'VisionUnsupportedForModelError'

  constructor() {
    super('The selected model cannot view image attachments.')
  }
}

/** An attachment exceeds the model's ingestion bound. */
export class AttachmentTooLargeForModelError extends AttachmentCapabilityError {
  override readonly name: string = 'AttachmentTooLargeForModelError'

  constructor() {
    super('Attachment is too large for this model.')
  }
}

/** A referenced attachment cannot be resolved. */
export class AttachmentUnavailableForAiError extends AttachmentCapabilityError {
  override readonly name: string = 'AttachmentUnavailableForAiError'

  constructor() {
    super('Attachment unavailable.')
  }
}

/** More attachments than the model accepts in one request. */
export class TooManyAttachmentsForModelError extends AttachmentCapabilityError {
  override readonly name: string = 'TooManyAttachmentsForModelError'

  constructor() {
    super('Too many attachments for this model in one message.')
  }
}

/** True for the safe attachment-capability failures (public copy only). */
export function isAttachmentCapabilityError(error: unknown): error is AttachmentCapabilityError {
  return error instanceof AttachmentCapabilityError
}
