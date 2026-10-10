import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Attachment AI boundary (Step 1: local files + images, inert).
 *
 * Attachments must never reach Brain, Worker, providers, or any model
 * adapter: AI paths read message `content` only, and no AI-side module
 * may import the attachment store. The protocol + store surface stays
 * main-owned and display-only.
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

describe('attachment AI boundary', () => {
  it('no AI-side module imports the attachment store or protocol', () => {
    for (const relative of AI_SURFACES) {
      const source = readMainSource(relative)
      for (const forbidden of ['chat-attachments', 'ChatAttachment', 'stark-attachment', 'message_attachments']) {
        assert.ok(!source.includes(forbidden), `${relative} must not reference ${forbidden}`)
      }
    }
  })

  it('provider history loaders read message content only', () => {
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
