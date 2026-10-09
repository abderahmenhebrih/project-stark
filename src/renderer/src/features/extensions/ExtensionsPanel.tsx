import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import type { ExtensionEntry, InstalledExtensionEntry } from '../../../../shared/extension-registry/types'
import { getExtensionHostStatus, installExtension, listFeaturedExtensions, listInstalledExtensions, searchExtensionCatalog, startExtensionHost, stopExtensionHost, uninstallExtension } from '../../lib/stark-api'
import type { ExtensionHostState } from '../../../../shared/extension-host/types'
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
 * Extension catalog browser with safe installation (store only).
 *
 * The panel never touches the registry or the filesystem: keystrokes
 * debounce 300ms into the main-owned catalog bridge (fixed Open VSX
 * origin, 10s timeout, zero retries, max 20 results), with stale
 * responses discarded by monotonic request ids. Install buttons send
 * normalized identity only; download, validation, extraction, and
 * storage are main-owned and bounded, and installed packages stay
 * inert files (never activated or executed). All registry text
 * renders as plain React text.
 */
export function ExtensionsPanel(): ReactElement {
  const [input, setInput] = useState('')
  const [state, dispatch] = useReducer(catalogReducer, undefined, initialCatalogState)
  const { entries, loading, error, loadedQuery } = state
  const requestIdRef = useRef(0)
  const [installingIds, setInstallingIds] = useState<readonly string[]>([])
  const [failedIds, setFailedIds] = useState<readonly string[]>([])
  const [installedByKey, setInstalledByKey] = useState<Readonly<Record<string, InstalledExtensionEntry>>>({})
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [uninstallingKeys, setUninstallingKeys] = useState<readonly string[]>([])
  const [uninstallFailedKeys, setUninstallFailedKeys] = useState<readonly string[]>([])
  const [hostState, setHostState] = useState<ExtensionHostState>('stopped')
  const [hostBusy, setHostBusy] = useState(false)

  function installedKeyOf(namespace: string, name: string, version: string): string {
    return `${namespace}.${name}@${version}`
  }

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

  useEffect(() => {
    let cancelled = false
    listInstalledExtensions().then(
      (installed) => {
        if (cancelled) {
          return
        }
        const next: Record<string, InstalledExtensionEntry> = {}
        for (const item of installed) {
          next[`${item.namespace}.${item.name}@${item.version}`] = item
        }
        setInstalledByKey(next)
      },
      () => {
        // Installed state stays empty; catalog rows remain installable.
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  function refreshInstalled(): void {
    listInstalledExtensions().then(
      (installed) => {
        const next: Record<string, InstalledExtensionEntry> = {}
        for (const item of installed) {
          next[`${item.namespace}.${item.name}@${item.version}`] = item
        }
        setInstalledByKey(next)
      },
      () => {
        // Keep the last known installed set on refresh failure.
      }
    )
  }

  function refreshHostStatus(): void {
    getExtensionHostStatus().then(
      (status) => setHostState(status.state),
      () => {
        // Keep the last known host state on refresh failure.
      }
    )
  }

  useEffect(() => {
    refreshHostStatus()
  }, [])

  function handleStartHost(): void {
    if (hostBusy) {
      return
    }
    setHostBusy(true)
    startExtensionHost().then(
      (status) => {
        setHostState(status.state)
        setHostBusy(false)
      },
      () => {
        setHostBusy(false)
        refreshHostStatus()
      }
    )
  }

  function handleStopHost(): void {
    if (hostBusy) {
      return
    }
    setHostBusy(true)
    stopExtensionHost().then(
      (status) => {
        setHostState(status.state)
        setHostBusy(false)
      },
      () => {
        setHostBusy(false)
        refreshHostStatus()
      }
    )
  }

  function handleInstall(entry: ExtensionEntry): void {
    if (installingIds.includes(entry.id)) {
      return
    }
    setFailedIds((ids) => ids.filter((id) => id !== entry.id))
    setInstallingIds((ids) => (ids.includes(entry.id) ? ids : [...ids, entry.id]))
    installExtension({ namespace: entry.namespace, name: entry.name, version: entry.version }).then(
      () => {
        setInstallingIds((ids) => ids.filter((id) => id !== entry.id))
        refreshInstalled()
      },
      () => {
        setInstallingIds((ids) => ids.filter((id) => id !== entry.id))
        setFailedIds((ids) => (ids.includes(entry.id) ? ids : [...ids, entry.id]))
      }
    )
  }

  function installKey(entry: ExtensionEntry): string {
    return installedKeyOf(entry.namespace, entry.name, entry.version)
  }

  function renderInstallAction(entry: ExtensionEntry): ReactElement {
    if (installedByKey[installKey(entry)] !== undefined) {
      return (
        <button className="extensions__installed" type="button" disabled aria-label={`${entry.displayName} installed`}>
          Installed
        </button>
      )
    }
    if (installingIds.includes(entry.id)) {
      return (
        <button className="extensions__install" type="button" disabled aria-label={`Installing ${entry.displayName}`}>
          Installing…
        </button>
      )
    }
    if (failedIds.includes(entry.id)) {
      return (
        <span className="extensions__install-failed">
          <span className="extensions__install-failed-copy">Install failed</span>
          <button className="extensions__retry" type="button" onClick={() => handleInstall(entry)}>
            Retry
          </button>
        </span>
      )
    }
    return (
      <button
        className="extensions__install"
        type="button"
        onClick={() => handleInstall(entry)}
        aria-label={`Install ${entry.displayName}`}
      >
        Install
      </button>
    )
  }

  function handleUninstallRequest(item: InstalledExtensionEntry): void {
    setUninstallFailedKeys((keys) => keys.filter((key) => key !== installedKeyOf(item.namespace, item.name, item.version)))
    setConfirmingKey(installedKeyOf(item.namespace, item.name, item.version))
  }

  function handleUninstallCancel(): void {
    setConfirmingKey(null)
  }

  function handleUninstallConfirm(item: InstalledExtensionEntry): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (uninstallingKeys.includes(key)) {
      return
    }
    setConfirmingKey(null)
    setUninstallingKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
    uninstallExtension({ namespace: item.namespace, name: item.name, version: item.version }).then(
      () => {
        setUninstallingKeys((keys) => keys.filter((other) => other !== key))
        refreshInstalled()
      },
      () => {
        setUninstallingKeys((keys) => keys.filter((other) => other !== key))
        setUninstallFailedKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
      }
    )
  }

  function renderInstalledRow(item: InstalledExtensionEntry): ReactElement {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    return (
      <li key={key} className="extensions__installed-row">
        <span className="extensions__icon-fallback" aria-hidden="true">
          <StarkIcon name="extensions" size={16} />
        </span>
        <span className="extensions__installed-details">
          <span className="extensions__installed-name">{item.displayName}</span>
          <span className="extensions__installed-meta">
            {item.namespace} · {item.version}
          </span>
        </span>
        {uninstallingKeys.includes(key) ? (
          <button className="extensions__uninstall" type="button" disabled aria-label={`Uninstalling ${item.displayName}`}>
            Uninstalling…
          </button>
        ) : confirmingKey === key ? (
          <span className="extensions__confirm">
            <span className="extensions__confirm-copy">
              Uninstall {item.displayName}? This removes the extension package from STARK. It does not modify your
              project files.
            </span>
            <span className="extensions__confirm-actions">
              <button className="extensions__secondary" type="button" onClick={handleUninstallCancel}>
                Cancel
              </button>
              <button
                className="extensions__uninstall"
                type="button"
                onClick={() => handleUninstallConfirm(item)}
                aria-label={`Confirm uninstall of ${item.displayName}`}
              >
                Uninstall
              </button>
            </span>
          </span>
        ) : uninstallFailedKeys.includes(key) ? (
          <span className="extensions__install-failed">
            <span className="extensions__install-failed-copy">Uninstall failed</span>
            <button className="extensions__retry" type="button" onClick={() => handleUninstallRequest(item)}>
              Retry
            </button>
          </span>
        ) : (
          <button
            className="extensions__uninstall"
            type="button"
            onClick={() => handleUninstallRequest(item)}
            aria-label={`Uninstall ${item.displayName}`}
          >
            Uninstall
          </button>
        )}
      </li>
    )
  }

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
                <div className="extensions__actions">{renderInstallAction(entry)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {Object.values(installedByKey).length > 0 && (
        <>
          <p className="extensions__group-name">Installed</p>
          <ul className="extensions__list" aria-label="Installed extensions">
            {Object.values(installedByKey).map((item) => renderInstalledRow(item))}
          </ul>
        </>
      )}
      <p className="extensions__footnote">Installed packages stay inert — nothing runs yet.</p>
      <p className="extensions__group-name">Built-in</p>
      <ul className="extensions__list">
        {BUILT_IN.map((name) => (
          <li key={name} className="extensions__scope extensions__scope--builtin">
            {name}
          </li>
        ))}
      </ul>
      <p className="extensions__group-name">Extension Host</p>
      <p className="extensions__body">Developer foundation preview. Installed extensions cannot run yet.</p>
      <div className="extensions__host-row">
        <span className="extensions__host-status" role="status">
          Status: {hostState}
        </span>
        {hostState === 'ready' ? (
          <button
            className="extensions__secondary"
            type="button"
            onClick={handleStopHost}
            disabled={hostBusy}
            aria-label="Stop Extension Host"
          >
            {hostBusy ? 'Stopping…' : 'Stop host'}
          </button>
        ) : (
          <button
            className="extensions__secondary"
            type="button"
            onClick={handleStartHost}
            disabled={hostBusy}
            aria-label="Start Extension Host"
          >
            {hostBusy ? 'Starting…' : 'Start host'}
          </button>
        )}
      </div>
    </section>
  )
}
