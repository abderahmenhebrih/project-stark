import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Context content-safety: attached file excerpts, manual notes, and
 * assistant-adjacent history chips must remain inert strings rendered
 * as React text only. Hostile markup (including content that arrived
 * inside a workspace file) must never reach an HTML sink.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('session context content safety', () => {
  it('renders chips and previews as React text with no HTML sinks', () => {
    for (const relative of ['features/sessions/ContextCard.tsx', 'features/sessions/SessionPanel.tsx']) {
      const source = readRenderer(relative)
      for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html', 'markdown']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
    const card = readRenderer('features/sessions/ContextCard.tsx')
    assert.ok(card.includes('<pre'), 'previews must render through a plain pre element')
  })

  it('keeps hostile file content inert in state and rendering', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>\x1b[31mred\x1b[0m'
    assert.equal(typeof hostile, 'string')
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('session__content'), 'history still renders through the plain-text element')
    assert.ok(!panel.includes('DOMPurify'), 'no sanitizer path — plain text only')
  })

  it('draft helpers never touch the DOM or Node APIs', () => {
    for (const relative of [
      'features/sessions/session-context-state.ts',
      'lib/session-context-api.ts',
      'lib/session-context-error.ts'
    ]) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML', 'node:']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('attach actions are real buttons, never hover-only', () => {
    for (const relative of ['features/explorer/Explorer.tsx', 'features/search/SearchPanel.tsx']) {
      const source = readRenderer(relative)
      assert.ok(source.includes('<button'), `${relative} must use real buttons for attach actions`)
    }
    const explorerCss = readRenderer('features/explorer/Explorer.css')
    assert.ok(explorerCss.includes('.explorer__attach'), 'tree attach action must be styled')
    const searchCss = readRenderer('features/search/SearchPanel.css')
    assert.ok(searchCss.includes('.search__attach'), 'search attach action must be styled')
    const sessionCss = readRenderer('features/sessions/session.css')
    assert.ok(sessionCss.includes('.context-card'), 'context cards must be styled')
    assert.ok(sessionCss.includes('.session__context'), 'attached-context section must be styled')
  })

  it('no attach happens without an explicit action', () => {
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    for (const forbidden of ['autoAttach', 'attachOnOpen', 'attachOnSave', 'attachOnEdit']) {
      assert.ok(!explorer.includes(forbidden), `Explorer must not contain ${forbidden}`)
    }
    assert.ok(explorer.includes('Attach selection'), 'editor excerpt attach must be explicit')
    assert.ok(explorer.includes('Attach file'), 'whole-file attach must be explicit')
    const contextTab = readRenderer('features/sessions/ContextTab.tsx')
    assert.ok(contextTab.includes('Add note') || contextTab.includes('Attach note'), 'manual note attach must be explicit')
  })
})
