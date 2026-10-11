import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { initialSearchState, searchPanelReducer, type WorkspaceSearchPanelState } from './search-state'

/**
 * Hackathon stabilization (H10): the Match-case toggle is honored end
 * to end — state carries the flag, the bridge receives it, and the
 * highlight follows the submitted sensitivity.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

describe('search case sensitivity', () => {
  it('reducer carries the submitted caseSensitive flag', () => {
    let state: WorkspaceSearchPanelState = { ...initialSearchState(), workspaceId: 2 }
    state = searchPanelReducer(state, {
      type: 'search-started',
      workspaceId: 2,
      query: 'Foo',
      caseSensitive: true,
      requestId: 1
    })
    assert.equal(state.caseSensitive, true)
    assert.equal(state.query, 'Foo')
    state = searchPanelReducer(state, {
      type: 'search-started',
      workspaceId: 2,
      query: 'Foo',
      caseSensitive: false,
      requestId: 2
    })
    assert.equal(state.caseSensitive, false)
  })

  it('panel wires the toggle to the bridge request (never hardcoded false)', () => {
    const panel = readSource('src', 'renderer', 'src', 'features', 'search', 'SearchPanel.tsx')
    assert.ok(panel.includes('caseSensitive'), 'panel must reference caseSensitive')
    assert.ok(
      panel.includes('caseSensitive: submittedCaseSensitive'),
      'bridge request must carry the submitted toggle value'
    )
    assert.ok(panel.includes('aria-label="Match case"'), 'toggle must be an accessible control')
    // No decorative dead state: the only remaining literal-false
    // construction is the useState default (off), never the request.
    const requestSites = panel.match(/caseSensitive:\s*false/g) ?? []
    assert.equal(requestSites.length, 0, 'no hardcoded caseSensitive:false may reach dispatch or the bridge')
  })

  it('highlight follows the submitted sensitivity', () => {
    const panel = readSource('src', 'renderer', 'src', 'features', 'search', 'SearchPanel.tsx')
    assert.ok(
      panel.includes('highlightPreview(match.preview, state.query, state.caseSensitive)'),
      'highlight must render with the submitted sensitivity'
    )
  })
})
