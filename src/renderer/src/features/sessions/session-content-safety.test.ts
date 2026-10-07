import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Session content-safety: message text (including hostile markup and
 * ANSI-like escapes) must remain inert strings rendered as React text
 * only. No HTML sinks, no Markdown HTML parsing, in either the panel
 * or the composer path.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('session content safety', () => {
  it('renders messages as React text with no HTML sinks', () => {
    const source = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(source.includes('session__content'), 'messages must render through the plain-text content element')
    for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html']) {
      assert.ok(!source.includes(forbidden), `SessionPanel must not contain ${forbidden}`)
    }
  })

  it('keeps hostile strings inert in state and rendering', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>\x1b[31mred\x1b[0m'
    assert.equal(typeof hostile, 'string')
    const source = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!source.includes('markdown'), 'no Markdown renderer in Stage 13')
    assert.ok(!source.includes('marked'), 'no Markdown package usage')
    assert.ok(!source.includes('DOMPurify'), 'no HTML sanitizer path either — plain text only')
  })

  it('state and composer helpers never touch the DOM', () => {
    for (const relative of ['features/sessions/session-state.ts', 'features/sessions/composer-keys.ts', 'lib/session-error.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('composer is a plain textarea, not an HTML editor', () => {
    const source = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(source.includes('<textarea'), 'composer must be a textarea')
    assert.ok(source.includes('session__input'), 'composer must use the plain-text input style')
    assert.ok(!source.includes('contentEditable'), 'composer must not be an HTML editor')
  })

  it('assistant, model, and error strings stay inert plain text', () => {
    // Stage 14 renders provider-supplied assistant text through the
    // same inert surface; model IDs, connection labels, and error copy
    // are React text as well.
    const hostileAssistant = '<script>alert(1)</script><img src=x onerror=alert(1)>\x1b[32mok\x1b[0m'
    assert.equal(typeof hostileAssistant, 'string')
    const source = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(!source.includes('markdown'), 'no Markdown renderer in Stage 14 either')
    assert.ok(source.includes('session__message--assistant'), 'assistant rows reuse the inert message surface')
    for (const relative of ['features/sessions/provider-state.ts', 'lib/provider-error.ts']) {
      const helper = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML']) {
        assert.ok(!helper.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
