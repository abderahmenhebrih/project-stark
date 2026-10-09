import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * STARK STAGE 31 MANUAL REVIEW FIX 06 — live workspace search.
 *
 * Static renderer guarantees for the Search surface only: no case
 * toggle, no manual submit, 250ms debounced live search that is always
 * case-insensitive, stale-safe, grouped by file, safely highlighted,
 * with attach/open flows preserved. Backend (Stage 7) untouched.
 */
function readSource(...parts: string[]): string {
  const file = join(process.cwd(), ...parts)
  assert.ok(existsSync(file), `${parts.join('/')} must exist`)
  return readFileSync(file, 'utf8')
}

function readRenderer(relative: string): string {
  return readSource('src', 'renderer', 'src', ...relative.split('/'))
}

describe('D06 live workspace search', () => {
  it('Case sensitive control no longer exists', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(!panel.includes('Case sensitive'), 'visible Case sensitive toggle must be gone')
    assert.ok(!panel.includes('caseSensitive, setCaseSensitive'), 'case toggle state must be gone')
    assert.ok(!panel.includes('search__case'), 'case toggle markup must be gone')
    assert.ok(!panel.includes('type="checkbox"'), 'no checkbox may remain on the search surface')
    const css = readRenderer('features/search/SearchPanel.css')
    assert.ok(!css.includes('.search__case'), 'dead case-toggle CSS must be removed')
  })

  it('Search button no longer exists; search is live', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(!panel.includes('search__submit'), 'large lime Search button must be gone')
    assert.ok(!panel.includes('type="submit"'), 'no manual submit requirement may remain')
    assert.ok(!panel.includes('<form'), 'form-submit wrapper must be retired for live search')
    const css = readRenderer('features/search/SearchPanel.css')
    assert.ok(!css.includes('.search__submit'), 'dead submit-button CSS must be removed')
  })

  it('search is always case-insensitive literal', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('caseSensitive: false'), 'renderer must call the existing API with caseSensitive: false')
    assert.ok(!panel.includes('submittedCase'), 'no per-submit case option may remain')
    assert.ok(!panel.includes('toLowerCase') || panel.includes('highlightPreview'), 'only highlighting may fold case')
  })

  it('query automatically searches after a bounded 250ms debounce', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('LIVE_SEARCH_DEBOUNCE_MS = 250'), 'debounce must be exactly 250ms')
    assert.ok(panel.includes('setTimeout'), 'typing must schedule a debounced request')
    assert.ok(panel.includes('clearTimeout(timer)'), 'query changes must cancel the pending renderer timer')
    assert.ok(panel.includes('useEffect'), 'search must run automatically while typing')
    assert.ok(!panel.includes('setInterval'), 'no polling timers may exist')
  })

  it('empty query makes no request and clears results', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes("input.trim().length === 0"), 'empty query must be detected before any backend call')
    assert.ok(panel.includes('search-cleared'), 'empty query must clear results through state')
    const state = readRenderer('features/search/search-state.ts')
    assert.ok(state.includes('search-cleared'), 'reducer must support clearing without a request')
  })

  it('rapid typing collapses into one debounced request with stale protection', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('requestIdRef'), 'monotonic request/version id must guard overlapping searches')
    assert.ok(panel.includes('requestIdRef.current !== requestId'), 'older responses must not overwrite newer results')
    const state = readRenderer('features/search/search-state.ts')
    assert.ok(state.includes('isCurrentRequest'), 'reducer must reject stale and cross-workspace results')
    assert.ok(!panel.includes('retry'), 'no automatic retry loops may exist')
  })

  it('in-flight state is subtle and terminates', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('search__spinner'), 'a subtle searching indicator must sit near the input')
    assert.ok(panel.includes('state.loading &&'), 'indicator must show only while in flight')
    const state = readRenderer('features/search/search-state.ts')
    assert.ok(state.includes('loading: false'), 'latest completion must clear loading')
    assert.ok(!panel.includes('full-pane'), 'no full-pane loading screen may exist')
  })

  it('clear control resets query and results', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('search__clear'), 'clear × must exist on the field')
    assert.ok(panel.includes("aria-label=\"Clear search\""), 'clear must be labelled')
    assert.ok(panel.includes("setInput('')"), 'clear must reset the query')
    const css = readRenderer('features/search/SearchPanel.css')
    assert.ok(css.includes('.search__clear'), 'clear control must be styled')
  })

  it('premium search field metrics hold', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('placeholder="Search project…"'), 'placeholder must read Search project…')
    assert.ok(panel.includes('name="search"'), 'search SVG icon must sit left in the field')
    const css = readRenderer('features/search/SearchPanel.css')
    const field = css.match(/\.search__field\s*\{[^}]*\}/)
    assert.ok(field !== null, 'field CSS must exist')
    assert.ok(field[0].includes('min-height: 38px') && field[0].includes('max-height: 40px'), 'field must be 38–40px tall')
    assert.ok(field[0].includes('width: 100%'), 'field must be full width')
    assert.ok(field[0].includes('border-radius: 8px'), 'field radius must be 8px')
    assert.ok(field[0].includes('background: var(--stark-elevated)'), 'field must be elevated neutral, never a neon fill')
    assert.ok(css.includes('.search__field:focus-within'), 'focus must show a subtle ring')
  })

  it('empty and no-result states exist without form chrome', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('Search files in this workspace'), 'calm no-query state must exist')
    assert.ok(panel.includes('Start typing to search'), 'muted typing helper must exist')
    assert.ok(panel.includes('No results for'), 'zero-result copy must exist')
    assert.ok(panel.includes('Try another search term.'), 'no-result helper must exist')
    assert.ok(!panel.includes('No matches found.'), 'legacy empty copy must be retired')
    assert.ok(!panel.includes('SEARCH PROJECT'), 'dominant uppercase form heading must be gone')
  })

  it('result count summary stays quiet', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('search__summary'), 'summary element must exist')
    assert.ok(panel.includes('in {state.filesMatched}'), 'summary must read “N matches in M files”')
    const css = readRenderer('features/search/SearchPanel.css')
    const summary = css.match(/\.search__summary\s*\{[^}]*\}/)
    assert.ok(summary !== null && summary[0].includes('font-size: 12px'), 'summary must be quiet 12px text')
  })

  it('results group by file with reused file icons', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('byFile'), 'flat results must group by relativePath in the renderer')
    assert.ok(panel.includes('match.relativePath'), 'grouping key must be the backend relativePath')
    assert.ok(panel.includes('search__group'), 'file group markup must exist')
    assert.ok(panel.includes('FILE_ICON_URLS[getFileIconKind(relativePath)]'), 'group headers must reuse the vscode-icons mapping')
    assert.ok(panel.includes('search__group-count'), 'match count badge must exist per group')
    assert.ok(!panel.includes('<form'), 'grouping must not add another search API')
  })

  it('match rows show line:column plus safely highlighted literal snippets', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('{match.line}:{match.column}'), 'rows must show line:column')
    assert.ok(panel.includes('search__result-location'), 'location must be styled muted monospace')
    assert.ok(panel.includes('highlightPreview(match.preview, state.query)'), 'snippets must highlight the literal query')
    assert.ok(panel.includes('<mark'), 'highlighting must use safe React spans')
    assert.ok(!panel.includes('dangerouslySetInnerHTML'), 'highlighting must never use HTML sinks')
    const css = readRenderer('features/search/SearchPanel.css')
    assert.ok(css.includes('.search__hit'), 'highlight style must be subtle lime, never a full neon card')
    assert.ok(css.includes('button.search__result:hover'), 'rows must use spacing plus subtle hover, not bordered cards')
  })

  it('attach and open flows are preserved through existing handlers', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('onAttachResult(match)'), 'attach must reuse the existing attach handler')
    assert.ok(panel.includes('title="Attach to context"'), 'attach tooltip must stay')
    assert.ok(panel.includes('search__attach'), 'compact attach action must remain styled and reachable')
    assert.ok(panel.includes('onSelectResult(match.relativePath, match.line, match.column)'), 'clicks must route through the Stage 6 safe open flow')
    const explorer = readRenderer('features/explorer/Explorer.tsx')
    assert.ok(explorer.includes('handleAttachSearchResult'), 'search attach must stay wired to context drafts')
    assert.ok(explorer.includes('handleSelectSearchResult'), 'search open must stay wired to safe file read')
  })

  it('only the result list scrolls with the existing dark scrollbar', () => {
    const css = readRenderer('features/search/SearchPanel.css')
    const results = css.match(/\.search__results\s*\{[^}]*\}/)
    assert.ok(results !== null && results[0].includes('overflow-y: auto'), 'only the result list may scroll')
    assert.ok(results[0].includes('scrollbar-width: thin'), 'results must keep the dark thin scrollbar')
    assert.ok(results[0].includes('#2c352e'), 'scrollbar thumb must stay muted dark neutral')
  })

  it('query and last valid results persist renderer-locally across activities', () => {
    const panel = readRenderer('features/search/SearchPanel.tsx')
    assert.ok(panel.includes('liveSearchCache'), 'renderer/session-local retention must exist')
    assert.ok(panel.includes('new Map<number'), 'retention must be keyed per workspace without a database')
  })

  it('Stage 7 backend, IPC, and schema remain untouched', () => {
    for (const file of ['features/search/SearchPanel.tsx', 'features/search/search-state.ts']) {
      const source = readRenderer(file)
      assert.ok(!source.includes('ipcRenderer'), `${file} must not touch IPC directly`)
      assert.ok(!source.includes('.invoke('), `${file} must not add IPC invokes`)
    }
    const validation = readSource('src', 'main', 'workspace-search', 'search-file.ts')
    assert.ok(validation.includes('caseSensitive must be a boolean'), 'backend literal-only bounds must stay intact')
    assert.ok(validation.includes('ALLOWED_REQUEST_KEYS'), 'backend request bounds must stay intact')
    const dir = join(process.cwd(), 'src', 'main', 'database', 'migrations')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    assert.ok(files.includes('018-cloud-account.ts'), 'migration 018 must exist (schema v18)')
    assert.ok(!files.some((file) => file.startsWith('019')), 'no migration 019 may appear for a search pass')
    for (const area of ['main', 'preload']) {
      const root = join(process.cwd(), 'src', area)
      const entries: string[] = readdirSync(root)
      assert.ok(entries.length > 0, `src/${area} must exist untouched`)
    }
  })
})
