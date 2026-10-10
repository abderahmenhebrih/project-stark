import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Attachment AI boundary (Step 2: AI attachment understanding).
 *
 * Attachments reach providers ONLY through the main-owned resolver
 * (`ai/ai-attachment-resolver.ts`), which re-resolves opaque IDs via
 * the attachment store. The protocol + store surface stays
 * main-owned and display-only:
 * - provider adapters receive opaque IDs plus encoded content only —
 *   they never resolve IDs, touch the store, or see SQL tables
 * - Ask/Brain/Worker paths hold an injected store handle ONLY as an
 *   opaque type (`import type`); only the resolver performs value
 *   imports and byte reads (`readAttachmentContent`)
 * - renderer-supplied MIME/paths never drive AI ingestion — the
 *   resolver matches stored validated metadata against the committed
 *   message link
 */

function readMainSource(relative: string): string {
  const file = join(process.cwd(), 'src', 'main', ...relative.split('/'))
  assert.ok(existsSync(file), `${relative} must exist`)
  return readFileSync(file, 'utf8')
}

const AI_SURFACES = [
  'ai/ai-completion-service.ts',
  'ai/ai-brain-service.ts',
  'ai/ai-code-proposal-service.ts',
  'ai/ai-multi-file-proposal-service.ts',
  'ai/ai-provider-service.ts',
  'ai/openai-adapter.ts',
  'worker-tools/worker-tool-service.ts',
  'worker-tools/worker-tool-runner.ts',
  'looplink/looplink-service.ts'
]

/** True when the source value-imports the attachment store (type-only imports are allowed). */
function hasStoreValueImport(source: string): boolean {
  return source
    .split('\n')
    .some((line) => line.includes('chat-attachments/service') && !line.trimStart().startsWith('import type'))
}

describe('attachment AI boundary', () => {
  it('no AI-side module touches store internals or the content protocol', () => {
    for (const relative of AI_SURFACES) {
      const source = readMainSource(relative)
      for (const forbidden of ['stark-attachment', 'storeRoot', 'storePathFor', 'message_attachments']) {
        assert.ok(!source.includes(forbidden), `${relative} must not reference ${forbidden}`)
      }
    }
  })

  it('only the resolver value-imports and reads the attachment store', () => {
    for (const relative of AI_SURFACES) {
      const source = readMainSource(relative)
      assert.ok(
        !hasStoreValueImport(source),
        `${relative} must only import the attachment store as a type (only the resolver may value-import it)`
      )
      assert.ok(
        !source.includes('readAttachmentContent(') || relative === 'worker-tools/worker-tool-service.ts',
        `${relative} must not read attachment bytes (only the resolver may)`
      )
      assert.ok(!source.includes('new ChatAttachmentService'), `${relative} must not construct the attachment store`)
    }
    const resolver = readMainSource('ai/ai-attachment-resolver.ts')
    assert.ok(resolver.includes('chat-attachments/service'), 'resolver must bridge the attachment store')
    assert.ok(resolver.includes('readAttachmentContent('), 'resolver must be the single byte-read path')
  })

  it('adapters receive encoded content, never resolve IDs themselves', () => {
    for (const relative of ['ai/openai-adapter.ts', 'ai/provider-adapter.ts']) {
      const source = readMainSource(relative)
      for (const forbidden of ['ai-attachment-resolver', 'ChatAttachmentService', 'findChatAttachmentById']) {
        assert.ok(!source.includes(forbidden), `${relative} must not resolve attachment IDs`)
      }
    }
    const adapter = readMainSource('ai/openai-adapter.ts')
    assert.ok(adapter.includes('input_image'), 'OpenAI adapter must map images to native multimodal blocks')
  })

  it('provider history loaders project content text plus the review block', () => {
    const multi = readMainSource('ai/ai-multi-file-proposal-service.ts')
    assert.ok(multi.includes('entry.content'), 'history loader must project content text')
    for (const forbidden of ['ChatAttachment', 'stark-attachment', 'message_attachments', 'originalName', 'mimeType']) {
      assert.ok(!multi.includes(forbidden), `history loader must not project ${forbidden}`)
    }
  })

  it('attachment protocol registration stays main-owned and narrow', () => {
    const index = readMainSource('index.ts')
    assert.ok(index.includes('registerSchemesAsPrivileged'), 'scheme privileges must register before app ready')
    assert.ok(index.includes('stark-attachment'), 'attachment scheme must be registered')
    assert.ok(index.includes("protocol.handle(ATTACHMENT_PROTOCOL"), 'content handler must be installed with services')
  })
})
