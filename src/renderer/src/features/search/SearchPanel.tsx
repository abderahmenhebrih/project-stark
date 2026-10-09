import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { WorkspaceSearchMatch } from '../../../../shared/workspace-search/types'
import { searchWorkspace } from '../../lib/stark-api'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { FILE_ICON_URLS } from '../explorer/fileIconAssets'
import { getFileIconKind } from '../explorer/fileIconForName'
import { initialSearchState, searchPanelReducer } from './search-state'
import './SearchPanel.css'

interface SearchPanelProps {
  readonly workspaceId: number
  readonly onSelectResult: (relativePath: string, line: number, column: number) => void
  readonly onAttachResult?: (match: WorkspaceSearchMatch) => void
}

/** Bounded live-search debounce: one request per 250ms of typing quiet. */
const LIVE_SEARCH_DEBOUNCE_MS = 250

/**
 * Renderer/session-local live query cache: keeps the last query and last
 * valid results per workspace while the drawer switches activities
 * (Explorer → Search → Git → Search unmounts this panel). No database,
 * no backend — module state only, cleared on workspace change by key.
 */
interface CachedSearch {
  readonly input: string
  readonly matches: readonly WorkspaceSearchMatch[]
  readonly filesMatched: number
  readonly query: string
  readonly submitted: boolean
}

const liveSearchCache = new Map<number, CachedSearch>()

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t search this project.'
}

/**
 * Safe literal highlighter: segments the snippet into React text nodes
 * with the case-insensitive literal query wrapped in <mark>. No HTML
 * parsing, no HTML sinks — hostile preview text stays inert.
 */
function highlightPreview(preview: string, query: string): readonly ReactNode[] {
  if (query === '') {
    return [preview]
  }
  const haystack = preview.toLowerCase()
  const needle = query.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  let found = haystack.indexOf(needle, cursor)
  while (found !== -1) {
    if (found > cursor) {
      parts.push(preview.slice(cursor, found))
    }
    parts.push(
      <mark key={key} className="search__hit">
        {preview.slice(found, found + query.length)}
      </mark>
    )
    key += 1
    cursor = found + query.length
    found = haystack.indexOf(needle, cursor)
  }
  parts.push(preview.slice(cursor))
  return parts
}

/**
 * Live workspace search panel. No case toggle (always case-insensitive
 * literal), no manual submit — typing debounces 250ms into the existing
 * workspace.search bridge with caseSensitive: false. Stale responses
 * never overwrite newer ones (monotonic request ids, renderer-only).
 * Results group by relativePath using the existing vscode-icons mapping;
 * clicking a match reuses the Stage 6 safe open flow via onSelectResult.
 */
export function SearchPanel({ workspaceId, onSelectResult, onAttachResult }: SearchPanelProps): ReactElement {
  const cached = liveSearchCache.get(workspaceId)
  const [state, dispatch] = useReducer(searchPanelReducer, workspaceId, (id) => ({
    ...initialSearchState(),
    workspaceId: id,
    query: cached?.query ?? '',
    matches: cached?.matches ?? [],
    filesMatched: cached?.filesMatched ?? 0,
    submitted: cached?.submitted ?? false
  }))
  const [input, setInput] = useState(cached?.input ?? '')
  const requestIdRef = useRef(0)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (input.trim().length === 0) {
      requestIdRef.current += 1
      if (stateRef.current.submitted || stateRef.current.loading || stateRef.current.matches.length > 0) {
        dispatch({ type: 'search-cleared', workspaceId })
      }
      liveSearchCache.delete(workspaceId)
      return
    }
    const timer = setTimeout(() => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      const submittedWorkspaceId = workspaceId
      const submittedQuery = input
      dispatch({
        type: 'search-started',
        workspaceId: submittedWorkspaceId,
        query: submittedQuery,
        caseSensitive: false,
        requestId
      })
      searchWorkspace({ workspaceId: submittedWorkspaceId, query: submittedQuery, caseSensitive: false }).then(
        (result) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'search-succeeded', workspaceId: result.workspaceId, requestId, result })
        },
        (error: unknown) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'search-failed', workspaceId: submittedWorkspaceId, requestId, message: toErrorMessage(error) })
        }
      )
    }, LIVE_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [input, workspaceId])

  useEffect(() => {
    if (state.submitted && !state.loading && state.error === null) {
      liveSearchCache.set(workspaceId, {
        input,
        matches: state.matches,
        filesMatched: state.filesMatched,
        query: state.query,
        submitted: state.submitted
      })
    }
  }, [input, state, workspaceId])

  function handleSelect(match: WorkspaceSearchMatch): void {
    if (state.workspaceId !== workspaceId) {
      return
    }
    onSelectResult(match.relativePath, match.line, match.column)
  }

  function handleClear(): void {
    setInput('')
  }

  const groups = useMemo(() => {
    const byFile = new Map<string, WorkspaceSearchMatch[]>()
    for (const match of state.matches) {
      const list = byFile.get(match.relativePath)
      if (list !== undefined) {
        list.push(match)
      } else {
        byFile.set(match.relativePath, [match])
      }
    }
    return [...byFile.entries()]
  }, [state.matches])

  const trimmed = input.trim()
  const showInitial = trimmed.length === 0
  const showNoResults = !showInitial && !state.loading && state.error === null && state.submitted && state.matches.length === 0

  return (
    <section className="search" aria-label="Search">
      <div className="search__field">
        <span className="search__field-icon" aria-hidden="true">
          <StarkIcon name="search" size={16} />
        </span>
        <input
          id="workspace-search-input"
          className="search__input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search project…"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search project"
        />
        {input.length > 0 && (
          <button className="search__clear" type="button" onClick={handleClear} aria-label="Clear search" title="Clear search">
            <StarkIcon name="close" size={14} />
          </button>
        )}
        {state.loading && (
          <span className="search__spinner" role="status" aria-label="Searching">
            Searching…
          </span>
        )}
      </div>
      {state.error !== null && (
        <p className="search__error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loading && state.error === null && state.submitted && state.matches.length > 0 && (
        <p className="search__summary" role="status">
          {state.matches.length} {state.matches.length === 1 ? 'match' : 'matches'} in {state.filesMatched}{' '}
          {state.filesMatched === 1 ? 'file' : 'files'}
        </p>
      )}
      {state.truncated && !state.loading && state.error === null && (
        <p className="search__truncated" role="status">
          Results truncated — refine your query for complete results.
        </p>
      )}
      {showInitial && (
        <div className="search__empty" role="status">
          <p className="search__empty-title">Search files in this workspace</p>
          <p className="search__empty-hint">Start typing to search</p>
        </div>
      )}
      {showNoResults && (
        <div className="search__empty" role="status">
          <p className="search__empty-title">No results for “{state.query}”</p>
          <p className="search__empty-hint">Try another search term.</p>
        </div>
      )}
      {groups.length > 0 && (
        <ul className="search__results" aria-label="Search results grouped by file">
          {groups.map(([relativePath, matches]) => (
            <li key={relativePath} className="search__group">
              <div className="search__group-head">
                <span className="search__group-icon" aria-hidden="true">
                  <img src={FILE_ICON_URLS[getFileIconKind(relativePath)]} alt="" draggable={false} />
                </span>
                <span className="search__group-path" title={relativePath}>
                  {relativePath}
                </span>
                <span className="search__group-count" aria-label={`${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}>
                  {matches.length}
                </span>
              </div>
              <ul className="search__group-matches">
                {matches.map((match, index) => (
                  <li key={`${match.relativePath}:${match.line}:${match.column}:${String(index)}`} className="search__result-row">
                    <button className="search__result" type="button" onClick={() => handleSelect(match)}>
                      <span className="search__result-location">
                        {match.line}:{match.column}
                      </span>
                      <span className="search__result-preview">{highlightPreview(match.preview, state.query)}</span>
                    </button>
                    {onAttachResult !== undefined && (
                      <button
                        className="search__attach"
                        type="button"
                        onClick={() => onAttachResult(match)}
                        aria-label={`Attach match in ${match.relativePath} line ${match.line} to chat`}
                        title="Attach to context"
                      >
                        <StarkIcon name="plus" size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
