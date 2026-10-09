import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import type { ExtensionEntry } from '../../../../shared/extension-registry/types'
import { listFeaturedExtensions, searchExtensionCatalog } from '../../lib/stark-api'
import { StarkIcon } from '../../components/icons/StarkIcon'
import './ExtensionsPanel.css'

/** Live-catalog debounce: one registry request per 300ms of typing quiet. */
const CATALOG_DEBOUNCE_MS = 300

const BUILT_IN: readonly string[] = ['STARK Editor', 'STARK Git', 'STARK Terminal']

interface CatalogState {
  readonly entries: readonly ExtensionEntry[]
  readonly loading: boolean
  readonly error: string | null
  readonly loadedQuery: string | null
}

type CatalogAction =
  | { readonly type: 'catalog-started' }
  | { readonly type: 'catalog-succeeded'; readonly entries: readonly ExtensionEntry[]; readonly query: string | null }
  | { readonly type: 'catalog-failed' }

function initialCatalogState(): CatalogState {
  return { entries: [], loading: false, error: null, loadedQuery: null }
}

function catalogReducer(state: CatalogState, action: CatalogAction): CatalogState {
  switch (action.type) {
    case 'catalog-started':
      return { ...state, loading: true, error: null }
    case 'catalog-succeeded':
      return { entries: action.entries, loading: false, error: null, loadedQuery: action.query }
    case 'catalog-failed':
      return { ...state, loading: false, error: 'We couldn’t load extensions.' }
  }
}

function formatDownloads(count: number): string {
  return count.toLocaleString('en-US')
}

function ExtensionIcon({ entry }: { readonly entry: ExtensionEntry }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (entry.iconUrl === null || failed) {
    return (
      <span className="extensions__icon-fallback" aria-hidden="true">
        <StarkIcon name="extensions" size={20} />
      </span>
    )
  }
  return (
    <img
      className="extensions__icon"
      src={entry.iconUrl}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * Extension catalog browser (display only).
 *
 * The panel never touches the registry: every keystroke debounces
 * 300ms into the main-owned catalog bridge (fixed Open VSX origin,
 * 10s timeout, zero retries, max 20 results), with stale responses
 * discarded by monotonic request ids. Empty queries show the popular
 * catalog; failures show calm copy plus a user-initiated Retry only.
 * All registry text renders as plain React text. Rows carry a
 * "Catalog only" badge — browsing is real, everything executable
 * lands in a later step.
 */
export function ExtensionsPanel(): ReactElement {
  const [input, setInput] = useState('')
  const [state, dispatch] = useReducer(catalogReducer, undefined, initialCatalogState)
  const { entries, loading, error, loadedQuery } = state
  const requestIdRef = useRef(0)

  useEffect(() => {
    const trimmed = input.trim()
    if (trimmed === '') {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      dispatch({ type: 'catalog-started' })
      listFeaturedExtensions().then(
        (result) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-succeeded', entries: result.entries, query: null })
        },
        () => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-failed' })
        }
      )
      return
    }
    const timer = setTimeout(() => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      dispatch({ type: 'catalog-started' })
      searchExtensionCatalog({ query: trimmed }).then(
        (result) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-succeeded', entries: result.entries, query: trimmed })
        },
        () => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-failed' })
        }
      )
    }, CATALOG_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [input])

  function handleRetry(): void {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const trimmed = input.trim()
    dispatch({ type: 'catalog-started' })
    const pending = trimmed === '' ? listFeaturedExtensions() : searchExtensionCatalog({ query: trimmed })
    pending.then(
      (result) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'catalog-succeeded', entries: result.entries, query: trimmed === '' ? null : trimmed })
      },
      () => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'catalog-failed' })
      }
    )
  }

  return (
    <section className="extensions" aria-label="Extensions">
      <div className="extensions__field">
        <span className="extensions__field-icon" aria-hidden="true">
          <StarkIcon name="search" size={16} />
        </span>
        <input
          className="extensions__input"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search extensions…"
          aria-label="Search extensions"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="extensions__summary">VS Code-compatible extensions</p>
      {loading && (
        <p className="extensions__status" role="status">
          Loading extensions…
        </p>
      )}
      {error !== null && !loading && (
        <div className="extensions__error" role="alert">
          <p className="extensions__error-copy">We couldn’t load extensions.</p>
          <button className="extensions__retry" type="button" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {error === null && !loading && entries.length === 0 && loadedQuery !== null && (
        <p className="extensions__status" role="status">
          No extensions found for “{loadedQuery}”.
        </p>
      )}
      {entries.length > 0 && (
        <ul className="extensions__results" aria-label="Extension catalog results">
          {entries.map((entry) => (
            <li key={entry.id} className="extensions__result">
              <ExtensionIcon entry={entry} />
              <div className="extensions__details">
                <p className="extensions__name">
                  {entry.displayName}
                  <span className="extensions__badge">Catalog only</span>
                </p>
                <p className="extensions__publisher">
                  {entry.publisher}
                  {entry.verified && <span className="extensions__verified"> · verified</span>}
                </p>
                <p className="extensions__description">{entry.description}</p>
                <p className="extensions__meta">
                  {entry.version} · {formatDownloads(entry.downloadCount)} downloads
                  {entry.rating !== null && ` · ★ ${entry.rating.toFixed(1)}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="extensions__footnote">Browsing only — setup flows land after STARK v1.</p>
      <p className="extensions__group-name">Built-in</p>
      <ul className="extensions__list">
        {BUILT_IN.map((name) => (
          <li key={name} className="extensions__scope extensions__scope--builtin">
            {name}
          </li>
        ))}
      </ul>
    </section>
  )
}
