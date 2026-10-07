import { useReducer, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { WorkspaceSearchMatch } from '../../../../shared/workspace-search/types'
import { searchWorkspace } from '../../lib/stark-api'
import { initialSearchState, searchPanelReducer } from './search-state'
import './SearchPanel.css'

interface SearchPanelProps {
  readonly workspaceId: number
  readonly onSelectResult: (relativePath: string, line: number, column: number) => void
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'We couldn’t search this project.'
}

/**
 * Human-facing workspace search panel. Explicit submission only (Enter or
 * button) — never on keystroke — calling the typed workspace.search bridge.
 * Results render as plain React text; clicking one reuses the existing
 * workspace-files read flow via onSelectResult. Old requests never
 * overwrite newer ones (request ids). The parent remounts this panel with
 * key={workspaceId} so switching workspaces clears input, options, and
 * results without cascading effects.
 */
export function SearchPanel({ workspaceId, onSelectResult }: SearchPanelProps): ReactElement {
  const [state, dispatch] = useReducer(searchPanelReducer, workspaceId, (id) => ({
    ...initialSearchState(),
    workspaceId: id
  }))
  const [input, setInput] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const requestIdRef = useRef(0)

  function handleSubmit(event: FormEvent): void {
    event.preventDefault()
    if (state.loading) {
      return
    }
    if (input.trim().length === 0) {
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const submittedWorkspaceId = workspaceId
    const submittedQuery = input
    const submittedCase = caseSensitive
    dispatch({
      type: 'search-started',
      workspaceId: submittedWorkspaceId,
      query: submittedQuery,
      caseSensitive: submittedCase,
      requestId
    })
    searchWorkspace({ workspaceId: submittedWorkspaceId, query: submittedQuery, caseSensitive: submittedCase }).then(
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
  }

  function handleSelect(match: WorkspaceSearchMatch): void {
    if (state.workspaceId !== workspaceId) {
      return
    }
    onSelectResult(match.relativePath, match.line, match.column)
  }

  const showEmpty = state.submitted && !state.loading && state.error === null && state.matches.length === 0

  return (
    <section className="search" aria-label="Search">
      <form className="search__form" onSubmit={handleSubmit}>
        <label className="search__label" htmlFor="workspace-search-input">
          Search project
        </label>
        <input
          id="workspace-search-input"
          className="search__input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="authentication"
          autoComplete="off"
          spellCheck={false}
          disabled={state.loading}
        />
        <label className="search__case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
            disabled={state.loading}
          />
          <span>Case sensitive</span>
        </label>
        <button className="search__submit" type="submit" disabled={state.loading || input.trim().length === 0}>
          {state.loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      {state.loading && (
        <p className="search__status" role="status">
          Searching…
        </p>
      )}
      {state.error !== null && (
        <p className="search__error" role="alert">
          {state.error}
        </p>
      )}
      {!state.loading && state.error === null && state.submitted && state.matches.length > 0 && (
        <p className="search__status" role="status">
          {state.matches.length} {state.matches.length === 1 ? 'match' : 'matches'} in {state.filesMatched}{' '}
          {state.filesMatched === 1 ? 'file' : 'files'}
        </p>
      )}
      {state.truncated && !state.loading && state.error === null && (
        <p className="search__truncated" role="status">
          Results truncated — refine your query for complete results.
        </p>
      )}
      {showEmpty && <p className="search__status">No matches found.</p>}
      {state.matches.length > 0 && (
        <ul className="search__results">
          {state.matches.map((match, index) => (
            <li key={`${match.relativePath}:${match.line}:${match.column}:${String(index)}`}>
              <button className="search__result" type="button" onClick={() => handleSelect(match)}>
                <span className="search__result-path">{match.relativePath}</span>
                <span className="search__result-location">
                  {match.line}:{match.column}
                </span>
                <span className="search__result-preview">{match.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
