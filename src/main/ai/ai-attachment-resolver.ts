import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { CodingSessionRepository } from '../database/repositories/coding-session-repository'
import type { ChatAttachmentService } from '../chat-attachments/service'
import { isValidAttachmentId } from '../chat-attachments/service'
import type { ProviderAttachmentContent } from './provider-adapter'
import {
  AttachmentUnavailableForAiError,
  attachmentsNeedVision,
  buildAiAttachmentReviewLines,
  capabilitiesForModel,
  formatAiAttachmentReviewBlock,
  planAiAttachments,
  type AiAttachment,
  type AiAttachmentPlan
} from './ai-attachment-context'

const STRICT_DECODER = new TextDecoder('utf-8', { fatal: true })

/** Main-side resolved payload for one attachment (never a path). */
export type ResolvedAiAttachment =
  | { readonly kind: 'image'; readonly id: string; readonly mimeType: string; readonly base64: string }
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'metadata'; readonly id: string; readonly reason: string }

/** Outcome map for the context-review surface (id → inclusion). */
export type AiAttachmentOutcomeMap = Map<string, { readonly included: boolean; readonly note: string }>

export interface ResolvedAiAttachmentSet {
  readonly payloads: readonly ResolvedAiAttachment[]
  readonly outcomes: AiAttachmentOutcomeMap
}

/** Review-visible attachment section for one provider request. */
export interface ChatAttachmentSection {
  /** Review block (what the model receives); null when no attachments. */
  readonly block: string | null
  /** Content-bearing payloads only (images + text, in order). */
  readonly payloads: readonly ProviderAttachmentContent[]
  /** True when the set contains in-budget images (needs vision). */
  readonly needsVision: boolean
}

/**
 * Builds the complete attachment section for one trailing message
 * (shared by Ask, Brain plan, and Worker paths).
 *
 * Loads committed link rows, plans against the model's capabilities,
 * and resolves bytes main-side when the store service is present.
 * Without the service (or with `forceMetadataOnly`), attachments
 * travel as explicitly-labeled metadata — never silently, never as
 * bytes. Filesystem paths never appear in the block or payloads.
 */
export function buildChatAttachmentSection(input: {
  sessions: CodingSessionRepository
  attachments: ChatAttachmentService | undefined
  messageId: number
  providerId: string
  model: string
  visionMode?: 'require' | 'describe'
  forceMetadataOnly?: boolean
}): ChatAttachmentSection {
  const rows = input.sessions.listAttachmentsForMessage(input.messageId)
  if (rows.length === 0) {
    return { block: null, payloads: [], needsVision: false }
  }
  const needsVision = attachmentsNeedVision(
    rows.map((row) => ({ kind: row.kind, size: row.sizeBytes }))
  )
  const capabilities = capabilitiesForModel(input.providerId, input.model)
  const plan = planAiAttachments({
    rows: rows.map((row) => ({
      attachmentId: row.attachmentId,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind
    })),
    capabilities,
    // Metadata-only Workers must never throw vision errors: the
    // section degrades to explicitly-labeled metadata instead.
    visionMode: input.visionMode ?? (input.forceMetadataOnly === true ? 'describe' : 'require')
  })
  if (input.attachments === undefined || input.forceMetadataOnly === true) {
    const note = input.forceMetadataOnly === true
      ? 'content not included (not relevant to the delegated task)'
      : 'content not included (attachment content unavailable)'
    const lines = buildAiAttachmentReviewLines({
      plan: plan.attachments,
      outcomes: new Map(plan.attachments.map((attachment) => [attachment.id, { included: false, note }]))
    })
    return { block: formatAiAttachmentReviewBlock(lines), payloads: [], needsVision }
  }
  const links = new Map(
    rows.map(
      (row) =>
        [
          row.attachmentId,
          { mimeType: row.mimeType, sizeBytes: row.sizeBytes, kind: row.kind, sha256: row.sha256 }
        ] as const
    )
  )
  const resolved = resolveAiAttachmentPayloads({
    plan,
    sessions: input.sessions,
    attachments: input.attachments,
    messageLinks: links
  })
  const lines = buildAiAttachmentReviewLines({ plan: plan.attachments, outcomes: resolved.outcomes })
  const meta = new Map(plan.attachments.map((attachment) => [attachment.id, attachment]))
  const payloads: ProviderAttachmentContent[] = []
  for (const payload of resolved.payloads) {
    const info = meta.get(payload.id)
    if (info === undefined) {
      continue
    }
    if (payload.kind === 'image') {
      payloads.push({
        kind: 'image',
        id: payload.id,
        name: info.name,
        mimeType: payload.mimeType,
        base64: payload.base64
      })
    } else if (payload.kind === 'text') {
      payloads.push({ kind: 'text', id: payload.id, name: info.name, mimeType: info.mimeType, text: payload.text })
    }
  }
  return { block: formatAiAttachmentReviewBlock(lines), payloads, needsVision }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Main-owned attachment resolver (Step 2).
 *
 * The ONLY path by which attachment bytes reach AI providers. Every
 * opaque attachment ID is re-resolved through the main-owned store:
 * stored metadata is matched against the committed message link,
 * bytes are integrity-checked (size + SHA-256), bounded, and encoded
 * main-side. The renderer never reads store files, never base64s
 * arbitrary paths, and filesystem paths never reach providers.
 *
 * No retries, no loops over the filesystem, no trust in
 * renderer-supplied MIME — stored validated metadata only.
 */
export function resolveAiAttachmentPayloads(input: {
  plan: AiAttachmentPlan
  sessions: CodingSessionRepository
  attachments: ChatAttachmentService
  messageLinks: ReadonlyMap<string, { readonly mimeType: string; readonly sizeBytes: number; readonly kind: 'image' | 'file'; readonly sha256: string }>
}): ResolvedAiAttachmentSet {
  const payloads: ResolvedAiAttachment[] = []
  const outcomes: AiAttachmentOutcomeMap = new Map()
  let textBudget = input.plan.textBudgetBytes
  for (const attachment of input.plan.attachments) {
    const resolved = resolveOneAttachment(input.sessions, input.attachments, input.messageLinks, attachment, textBudget)
    payloads.push(resolved.payload)
    outcomes.set(attachment.id, resolved.outcome)
    if (resolved.payload.kind === 'text') {
      textBudget -= Buffer.byteLength(resolved.payload.text, 'utf8')
    }
  }
  return { payloads, outcomes }
}

function resolveOneAttachment(
  sessions: CodingSessionRepository,
  attachments: ChatAttachmentService,
  messageLinks: ReadonlyMap<string, { readonly mimeType: string; readonly sizeBytes: number; readonly kind: 'image' | 'file'; readonly sha256: string }>,
  attachment: AiAttachment,
  textBudget: number
): { readonly payload: ResolvedAiAttachment; readonly outcome: { readonly included: boolean; readonly note: string } } {
  if (!isValidAttachmentId(attachment.id)) {
    throw new AttachmentUnavailableForAiError()
  }
  const link = messageLinks.get(attachment.id)
  if (link === undefined) {
    throw new AttachmentUnavailableForAiError()
  }
  const stored = sessions.findChatAttachmentById(attachment.id)
  if (stored === undefined) {
    throw new AttachmentUnavailableForAiError()
  }
  // Stored validated metadata must match the committed link — the
  // link is what the user reviewed, the store is what we read.
  if (
    stored.originalName !== attachment.name ||
    stored.mimeType !== link.mimeType ||
    stored.sizeBytes !== link.sizeBytes ||
    stored.kind !== link.kind ||
    stored.sha256 !== link.sha256
  ) {
    throw new AttachmentUnavailableForAiError()
  }
  let bytes: Buffer
  let mimeType: string
  try {
    const content = attachments.readAttachmentContent(attachment.id)
    bytes = content.bytes
    mimeType = content.mimeType
  } catch {
    throw new AttachmentUnavailableForAiError()
  }
  if (bytes.byteLength !== stored.sizeBytes || sha256Hex(bytes) !== stored.sha256) {
    throw new AttachmentUnavailableForAiError()
  }
  if (attachment.contentCapability === 'image') {
    if (!mimeType.startsWith('image/')) {
      throw new AttachmentUnavailableForAiError()
    }
    return {
      payload: { kind: 'image', id: attachment.id, mimeType, base64: bytes.toString('base64') },
      outcome: { included: true, note: 'image included in model request' }
    }
  }
  if (attachment.contentCapability === 'text') {
    let text: string
    try {
      text = STRICT_DECODER.decode(bytes)
    } catch {
      return {
        payload: { kind: 'metadata', id: attachment.id, reason: 'unreadable-text' },
        outcome: { included: false, note: 'content not included (could not be read as text)' }
      }
    }
    const textBytes = Buffer.byteLength(text, 'utf8')
    if (textBytes > textBudget) {
      return {
        payload: { kind: 'metadata', id: attachment.id, reason: 'context-budget' },
        outcome: { included: false, note: 'content not included (too large for model context)' }
      }
    }
    return {
      payload: { kind: 'text', id: attachment.id, text },
      outcome: { included: true, note: `text included (${String(text.length)} chars)` }
    }
  }
  const reason = attachment.kind === 'image' ? 'image-not-sent' : 'unsupported-document-type'
  return {
    payload: { kind: 'metadata', id: attachment.id, reason },
    outcome: { included: false, note: 'content not included (model cannot read this file type)' }
  }
}
