import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_AI_ATTACHMENT_COUNT,
  MAX_AI_IMAGE_BYTES,
  MAX_AI_TEXT_ATTACHMENT_BYTES,
  attachmentInclusionFor,
  hasTextAttachmentExtension,
  modelSupportsVision
} from '../../shared/ai/attachment-capabilities'
import {
  attachmentsNeedVision,
  buildAiAttachmentReviewLines,
  capabilitiesForModel,
  formatAiAttachmentReviewBlock,
  planAiAttachments,
  AttachmentTooLargeForModelError,
  TooManyAttachmentsForModelError,
  VisionUnsupportedForModelError,
  workerAttachmentsRelevant
} from './ai-attachment-context'

function row(overrides: {
  attachmentId?: string
  originalName?: string
  mimeType?: string
  sizeBytes?: number
  kind?: 'image' | 'file'
} = {}) {
  return {
    attachmentId: overrides.attachmentId ?? 'a'.repeat(32),
    originalName: overrides.originalName ?? 'hero.png',
    mimeType: overrides.mimeType ?? 'image/png',
    sizeBytes: overrides.sizeBytes ?? 420 * 1024,
    kind: overrides.kind ?? ('image' as const)
  }
}

describe('AI attachment capability model', () => {
  it('recognizes vision-capable OpenAI families and nothing else', () => {
    assert.equal(modelSupportsVision('openai', 'gpt-4o'), true)
    assert.equal(modelSupportsVision('openai', 'gpt-4o-mini'), true)
    assert.equal(modelSupportsVision('openai', 'gpt-4.1'), true)
    assert.equal(modelSupportsVision('openai', 'gpt-4-turbo'), true)
    assert.equal(modelSupportsVision('openai', 'gpt-5'), true)
    assert.equal(modelSupportsVision('openai', 'o3'), true)
    assert.equal(modelSupportsVision('openai', 'GPT-4O'), true)
    assert.equal(modelSupportsVision('openai', 'gpt-3.5-turbo'), false)
    assert.equal(modelSupportsVision('openai', 'text-embedding-3-small'), false)
    assert.equal(modelSupportsVision('openai', 'whisper-1'), false)
    assert.equal(modelSupportsVision('openai', 'mystery-future-model'), false)
    assert.equal(modelSupportsVision('other', 'gpt-4o'), false)
    assert.equal(modelSupportsVision('', ''), false)
  })

  it('derives per-model capabilities without assuming vision', () => {
    const vision = capabilitiesForModel('openai', 'gpt-4o')
    assert.equal(vision.supportsImages, true)
    assert.equal(vision.supportsMultipleImages, true)
    assert.equal(vision.supportsTextAttachments, true)
    assert.equal(vision.supportsDocuments, false)
    assert.equal(vision.maxImageBytes, MAX_AI_IMAGE_BYTES)
    assert.equal(vision.maxAttachmentCount, MAX_AI_ATTACHMENT_COUNT)
    const plain = capabilitiesForModel('openai', 'gpt-3.5-turbo')
    assert.equal(plain.supportsImages, false)
    assert.equal(plain.supportsMultipleImages, false)
    assert.equal(plain.supportsTextAttachments, true)
  })

  it('gates text ingestion by extension and the 1 MiB bound', () => {
    assert.equal(hasTextAttachmentExtension('notes.txt'), true)
    assert.equal(hasTextAttachmentExtension('app.TS'), true)
    assert.equal(hasTextAttachmentExtension('data.json'), true)
    assert.equal(hasTextAttachmentExtension('run.py'), true)
    assert.equal(hasTextAttachmentExtension('photo.png'), false)
    assert.equal(hasTextAttachmentExtension('doc.pdf'), false)
    assert.equal(hasTextAttachmentExtension('archive.zip'), false)
    assert.equal(hasTextAttachmentExtension('noext'), false)
    assert.equal(hasTextAttachmentExtension('secrets.env'), false)
    assert.equal(MAX_AI_TEXT_ATTACHMENT_BYTES, 1024 * 1024)
  })

  it('plans images for vision models and fails explicitly otherwise', () => {
    const vision = capabilitiesForModel('openai', 'gpt-4o')
    const plan = planAiAttachments({ rows: [row(), row({ attachmentId: 'b'.repeat(32), originalName: 'b.png' })], capabilities: vision })
    assert.equal(plan.attachments.length, 2)
    assert.ok(plan.attachments.every((entry) => entry.contentCapability === 'image'))
    // Ordering is preserved.
    assert.equal(plan.attachments[0]?.id, 'a'.repeat(32))
    assert.equal(plan.attachments[1]?.id, 'b'.repeat(32))
    const plain = capabilitiesForModel('openai', 'gpt-3.5-turbo')
    assert.throws(
      () => planAiAttachments({ rows: [row()], capabilities: plain }),
      VisionUnsupportedForModelError
    )
  })

  it('plans describe-mode metadata for non-vision Brain planning', () => {
    const plain = capabilitiesForModel('openai', 'gpt-3.5-turbo')
    const plan = planAiAttachments({ rows: [row()], capabilities: plain, visionMode: 'describe' })
    assert.equal(plan.attachments[0]?.contentCapability, 'metadata-only')
  })

  it('rejects oversize images and over-count sets explicitly', () => {
    const vision = capabilitiesForModel('openai', 'gpt-4o')
    assert.throws(
      () => planAiAttachments({ rows: [row({ sizeBytes: MAX_AI_IMAGE_BYTES + 1 })], capabilities: vision }),
      AttachmentTooLargeForModelError
    )
    const many = Array.from({ length: MAX_AI_ATTACHMENT_COUNT + 1 }, (_, index) =>
      row({ attachmentId: String(index).padStart(32, '0'), originalName: `f${String(index)}.txt`, mimeType: 'text/plain', kind: 'file', sizeBytes: 10 })
    )
    assert.throws(() => planAiAttachments({ rows: many, capabilities: vision }), TooManyAttachmentsForModelError)
  })

  it('plans bounded text and metadata-only documents', () => {
    const vision = capabilitiesForModel('openai', 'gpt-4o')
    const plan = planAiAttachments({
      rows: [
        row({ attachmentId: 'a'.repeat(32), originalName: 'notes.md', mimeType: 'text/markdown', kind: 'file', sizeBytes: 100 }),
        row({ attachmentId: 'b'.repeat(32), originalName: 'doc.pdf', mimeType: 'application/pdf', kind: 'file', sizeBytes: 100 }),
        row({ attachmentId: 'c'.repeat(32), originalName: 'huge.txt', mimeType: 'text/plain', kind: 'file', sizeBytes: MAX_AI_TEXT_ATTACHMENT_BYTES + 1 })
      ],
      capabilities: vision
    })
    assert.equal(plan.attachments[0]?.contentCapability, 'text')
    assert.equal(plan.attachments[1]?.contentCapability, 'metadata-only')
    assert.equal(plan.attachments[2]?.contentCapability, 'metadata-only')
  })

  it('detects vision need from committed rows only', () => {
    assert.equal(attachmentsNeedVision([{ kind: 'image', size: 100 }]), true)
    assert.equal(attachmentsNeedVision([{ kind: 'file', size: 100 }]), false)
    assert.equal(attachmentsNeedVision([]), false)
    // Oversize images cannot be sent even to vision models.
    assert.equal(attachmentsNeedVision([{ kind: 'image', size: MAX_AI_IMAGE_BYTES + 1 }]), false)
  })

  it('formats an accurate review block (what you reviewed is what the model received)', () => {
    const vision = capabilitiesForModel('openai', 'gpt-4o')
    const plan = planAiAttachments({ rows: [row()], capabilities: vision })
    const lines = buildAiAttachmentReviewLines({
      plan: plan.attachments,
      outcomes: new Map([['a'.repeat(32), { included: true, note: 'image included in model request' }]])
    })
    const block = formatAiAttachmentReviewBlock(lines)
    assert.ok(block.startsWith('[ATTACHMENTS 1]'))
    assert.ok(block.includes('hero.png'))
    assert.ok(block.includes('a'.repeat(32)))
    assert.ok(block.includes('image included in model request'))
    assert.ok(!block.includes('/tmp') && !block.includes('.bin') && !block.includes('storeRoot'))
  })

  it('gates Worker blobs on explicit relevance only', () => {
    const names = [{ name: 'hero.png' }]
    assert.equal(workerAttachmentsRelevant({ workerInstruction: 'Use the attached image as the hero.', userRequest: 'banner', attachments: names }), true)
    assert.equal(workerAttachmentsRelevant({ workerInstruction: 'Refactor the header.', userRequest: 'Use hero.png please', attachments: names }), true)
    assert.equal(workerAttachmentsRelevant({ workerInstruction: 'Refactor the header component.', userRequest: 'Make it blue', attachments: names }), false)
    assert.equal(workerAttachmentsRelevant({ workerInstruction: 'Anything', userRequest: 'Anything', attachments: [] }), false)
  })

  it('predicts renderer inclusion states conservatively', () => {
    assert.equal(
      attachmentInclusionFor('openai', 'gpt-4o', { kind: 'image', name: 'a.png', size: 10 }),
      'included-image'
    )
    assert.equal(
      attachmentInclusionFor('openai', 'gpt-3.5-turbo', { kind: 'image', name: 'a.png', size: 10 }),
      'unsupported'
    )
    assert.equal(
      attachmentInclusionFor('openai', 'gpt-4o', { kind: 'image', name: 'a.png', size: MAX_AI_IMAGE_BYTES + 1 }),
      'metadata-only'
    )
    assert.equal(
      attachmentInclusionFor('openai', 'gpt-3.5-turbo', { kind: 'file', name: 'n.txt', size: 10 }),
      'included-text'
    )
    assert.equal(
      attachmentInclusionFor('openai', 'gpt-3.5-turbo', { kind: 'file', name: 'd.pdf', size: 10 }),
      'metadata-only'
    )
  })
})
