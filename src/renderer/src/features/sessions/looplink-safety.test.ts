import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Looplink content-safety: continuity previews render only inert
 * text. Historical code/context uses plain previews; no HTML sinks,
 * no payload construction client-side, no auto-send triggers.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('looplink content safety', () => {
  it('renders continuity as React text with no HTML sinks', () => {
    for (const relative of [
      'features/sessions/SessionPanel.tsx',
      'features/sessions/looplink-state.ts'
    ]) {
      const source = readRenderer(relative)
      for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', '__html']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })

  it('creates no payload client-side and triggers no provider work', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    for (const forbidden of ['JSON.stringify', 'payload_hash', 'payloadHash']) {
      assert.ok(!panel.includes(forbidden), `SessionPanel must not contain ${forbidden}`)
    }
    const state = readRenderer('features/sessions/looplink-state.ts')
    for (const forbidden of ['generateResponse', 'runBrainWork', 'proposeAiFileChange', 'createHash', 'sha256']) {
      assert.ok(!state.includes(forbidden), `looplink-state must not contain ${forbidden}`)
    }
  })

  it('labels historical context distinctly from fresh attachments', () => {
    const panel = readRenderer('features/sessions/SessionPanel.tsx')
    assert.ok(panel.includes('Historical context snapshot'), 'old code must be labeled historical')
    assert.ok(panel.includes('Continuing from:'), 'source title must display')
  })

  it('helpers never touch the DOM or Node APIs', () => {
    for (const relative of ['features/sessions/looplink-state.ts', 'lib/looplink-api.ts']) {
      const source = readRenderer(relative)
      for (const forbidden of ['document.', 'window.', 'innerHTML', 'dangerouslySetInnerHTML', 'node:']) {
        assert.ok(!source.includes(forbidden), `${relative} must not contain ${forbidden}`)
      }
    }
  })
})
