import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Chat attachment surface (Step 1: local files + images, inert).
 *
 * Static guarantees for the renderer shell: composer paperclip +
 * draft strip with per-item removal, message rendering with image
 * thumbnails and file cards, attachment-aware send gating, and no
 * filesystem/voice/generation authority. Runs against repository
 * source (cwd is the repo root via npm).
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('chat attachment composer surface', () => {
  it('composer offers a paperclip attach action without redesign', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('handleAttach'), 'composer must wire the attach action')
    assert.ok(panel.includes('name="paperclip"'), 'attach action must use the paperclip glyph')
    assert.ok(panel.includes('aria-label="Attach files"'), 'attach action must be labelled')
    assert.ok(panel.includes('title="Attach files"'), 'attach action must tooltip')
    assert.ok(panel.includes('<textarea'), 'composer must stay a plain textarea')
    assert.ok(panel.includes('Message composer'), 'composer label must stay')
    assert.ok(panel.includes('session__send'), 'Send must stay')
    const icons = readRenderer('components/icons/StarkIcon.tsx')
    assert.ok(icons.includes('paperclip'), 'icon set must include the paperclip glyph')
  })

  it('draft attachments render with thumbnails and per-item removal', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__attachments'), 'draft strip must exist')
    assert.ok(panel.includes('session__attachment-thumb'), 'draft images must thumbnail')
    assert.ok(panel.includes('stark-attachment://'), 'draft thumbnails must load by opaque ID only')
    assert.ok(panel.includes('handleRemoveAttachment'), 'each draft must be removable')
    assert.ok(panel.includes('removeChatAttachmentDraft'), 'removal must release the draft asset main-side')
    assert.ok(panel.includes('attachError'), 'attach failures must surface calmly')
    const css = readRenderer('features/sessions/session.css')
    for (const selector of ['.session__attachments', '.session__attachment-thumb', '.session__attach']) {
      assert.ok(css.includes(selector), `composer CSS must style ${selector}`)
    }
  })

  it('send allows attachments-only messages and clears drafts on success', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('attachments.length === 0'), 'send gating must account for staged attachments')
    assert.ok(panel.includes('attachments: attachmentIds') || panel.includes('attachments: attachmentIds,'), 'send must carry attachment IDs')
    assert.ok(panel.includes('setAttachments([])'), 'successful sends must clear staged attachments')
    assert.ok(panel.includes('messageSendPayload'), 'all send modes must share one payload builder')
  })

  it('messages render image thumbnails and file cards as inert text', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__attachments-list'), 'message attachment block must exist')
    assert.ok(panel.includes('session__attachment-image'), 'message images must render bounded thumbnails')
    assert.ok(panel.includes('session__attachment-filecard'), 'message files must render compact cards')
    assert.ok(panel.includes('formatAttachmentSize'), 'file cards must show readable sizes')
    assert.ok(panel.includes('alt={attachment.name}'), 'image thumbnails must expose the filename accessibly')
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', '__html', 'contentEditable']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    const css = readRenderer('features/sessions/session.css')
    for (const selector of ['.session__attachments-list', '.session__attachment-image', '.session__attachment-filecard', '.session__attachment-name']) {
      assert.ok(css.includes(selector), `message CSS must style ${selector}`)
    }
  })

  it('attachment UI adds no filesystem, voice, or generation authority', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const forbidden of ['showOpenDialog', 'ipcRenderer', '.invoke(', 'MediaRecorder', 'getUserMedia', 'webkitSpeechRecognition', 'SpeechRecognition']) {
      assert.ok(!panel.includes(forbidden), `panel must not contain ${forbidden}`)
    }
    const api = readRenderer('lib/attachments-api.ts')
    assert.ok(api.includes('chooseChatAttachments'), 'picker helper must exist')
    assert.ok(api.includes('removeChatAttachmentDraft'), 'draft removal helper must exist')
    assert.ok(!api.includes('.invoke('), 'helpers must not invoke IPC directly')
  })

  it('protocol and schema witnesses stay narrow', () => {
    const constants = readSource('src', 'shared', 'constants', 'index.ts')
    assert.ok(constants.includes("attachmentsChoose: 'stark:attachments:choose'"), 'choose channel must be narrowly scoped')
    assert.ok(constants.includes("attachmentsRemoveDraft: 'stark:attachments:remove-draft'"), 'remove channel must be narrowly scoped')
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('019-message-attachments.ts'), 'migration 019 must exist (schema v19)')
    assert.ok(!files.some((file) => file.startsWith('020')), 'no migration 020 may appear')
  })
})
